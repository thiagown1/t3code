#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Dependency-free on purpose; see scripts/lib/upstream-sync.ts. The date only names the branch.

/**
 * Prepares an upstream sync on a dated branch, and stops at the first thing a
 * human has to decide.
 *
 *   vp run sync:upstream              # fetch, branch, merge, scoped checks
 *   vp run sync:upstream --dry-run    # report only, no branch, no merge
 *
 * It never pushes, never opens a PR, and never moves `main` or the fork branch.
 * On conflict it leaves the tree exactly as git left it — conflict markers and
 * all — and prints what to resolve. Resolving is the human's job.
 *
 * Exit codes: 0 done, 1 refused before touching anything, 2 conflicts left in
 * the tree, 3 merged clean but the scoped checks failed.
 *
 * Node builtins only, sharing `scripts/lib/upstream-sync.ts` with the daily
 * drift workflow so both answer "cheap or expensive" the same way.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  analyzeMigrations,
  collectDriftReport,
  git,
  listMigrations,
  listUpstreamChangedFiles,
  measureDrift,
  renderDriftMarkdown,
  resolveRef,
  tryGit,
  DEFAULT_BASE_REF,
  DEFAULT_UPSTREAM_REMOTE,
  UPSTREAM_REPOSITORY_URL,
  WORKSPACE_FILE,
  WORKSPACE_PLACEHOLDER,
  type MigrationFinding,
} from "./lib/upstream-sync.ts";

const EXIT_REFUSED = 1;
const EXIT_CONFLICTS = 2;
const EXIT_CHECKS_FAILED = 3;

const { values } = NodeUtil.parseArgs({
  options: {
    base: { type: "string", default: DEFAULT_BASE_REF },
    remote: { type: "string", default: DEFAULT_UPSTREAM_REMOTE },
    "upstream-branch": { type: "string", default: "main" },
    branch: { type: "string" },
    "no-fetch": { type: "boolean", default: false },
    "skip-checks": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const log = (message = "") => {
  process.stdout.write(`${message}\n`);
};

const refuse = (message: string): never => {
  process.stderr.write(`sync:upstream refused: ${message}\n`);
  process.exit(EXIT_REFUSED);
};

const repoRoot = (() => {
  const outcome = tryGit(process.cwd(), "rev-parse", "--show-toplevel");
  if (outcome.status !== 0) refuse("not inside a git worktree.");
  return outcome.stdout.trim();
})();

const upstreamRemote = values.remote;
const upstreamRef = `${upstreamRemote}/${values["upstream-branch"]}`;

/** Guards that run before anything is created, in the order they can bite. */
const assertPreconditions = () => {
  const remotes = git(repoRoot, "remote")
    .split("\n")
    .map((line) => line.trim());
  if (!remotes.includes(upstreamRemote)) {
    refuse(
      `no "${upstreamRemote}" remote. Add it with:\n` +
        `  git remote add ${upstreamRemote} ${UPSTREAM_REPOSITORY_URL}`,
    );
  }

  // A blob:none clone fetches blobs lazily from a promisor remote. Without this
  // flag on the upstream remote, the merge dies mid-way looking for blobs that
  // only upstream has.
  const partial = tryGit(repoRoot, "config", "--get", "remote.origin.partialclonefilter");
  const promisor = tryGit(repoRoot, "config", "--get", `remote.${upstreamRemote}.promisor`);
  if (partial.stdout.trim() !== "" && promisor.stdout.trim() !== "true") {
    refuse(
      `this is a partial clone (${partial.stdout.trim()}) and "${upstreamRemote}" is not a promisor remote.\n` +
        `The merge would fail fetching blobs. Fix it with:\n` +
        `  git config remote.${upstreamRemote}.promisor true`,
    );
  }

  if (values["dry-run"]) return;

  const status = git(repoRoot, "status", "--porcelain");
  if (status.trim() !== "") {
    refuse("the working tree is dirty. Commit or stash first — a sync merge needs a clean tree.");
  }
  const gitDir = NodePath.resolve(repoRoot, git(repoRoot, "rev-parse", "--git-dir").trim());
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (NodeFS.existsSync(NodePath.join(gitDir, marker))) {
      refuse(`${marker} exists — finish or abort the operation in progress first.`);
    }
  }
};

const datedBranchName = (): string => {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `sync/upstream-${stamp}`;
};

interface WorkspacePackage {
  readonly dir: string;
  readonly scripts: ReadonlyArray<string>;
}

/**
 * The `packages:` globs from pnpm-workspace.yaml, read line-wise rather than
 * with a YAML parser to keep this script dependency-free.
 */
const readWorkspaceGlobs = (): ReadonlyArray<string> => {
  const content = NodeFS.readFileSync(NodePath.join(repoRoot, WORKSPACE_FILE), "utf8");
  const globs: Array<string> = [];
  let inPackages = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const entry = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!entry) break;
    globs.push(entry[1]!.replace(/^["']|["']$/g, ""));
  }
  return globs;
};

const packageDirOf = (file: string, globs: ReadonlyArray<string>): string | undefined => {
  const parts = file.split("/");
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const prefix = glob.slice(0, -2);
      if (parts.length > 2 && parts[0] === prefix) return `${parts[0]}/${parts[1]}`;
      continue;
    }
    if (parts[0] === glob && parts.length > 1) return glob;
  }
  return undefined;
};

const affectedPackages = (files: ReadonlyArray<string>): ReadonlyArray<WorkspacePackage> => {
  const globs = readWorkspaceGlobs();
  const dirs = new Set<string>();
  for (const file of files) {
    const dir = packageDirOf(file, globs);
    if (dir) dirs.add(dir);
  }
  return [...dirs]
    .sort()
    .flatMap((dir) => {
      const manifest = NodePath.join(repoRoot, dir, "package.json");
      if (!NodeFS.existsSync(manifest)) return [];
      const scripts = JSON.parse(NodeFS.readFileSync(manifest, "utf8")).scripts ?? {};
      return [
        {
          dir,
          scripts: ["typecheck", "test"].filter((script) => typeof scripts[script] === "string"),
        },
      ];
    })
    .filter((workspacePackage) => workspacePackage.scripts.length > 0);
};

/**
 * Vite+ ships a plain Node entry next to its shell shims, so this spawns the
 * script directly rather than a `.CMD` that would need a shell on Windows.
 */
const vpEntry = NodePath.join(repoRoot, "node_modules", "vite-plus", "bin", "vp");

const runScopedCheck = (workspacePackage: WorkspacePackage, script: string): boolean => {
  const args = ["run", "--filter", `./${workspacePackage.dir}`, script];
  log(`\n$ vp ${args.join(" ")}`);
  if (values["dry-run"]) return true;
  const result = NodeChildProcess.spawnSync(process.execPath, [vpEntry, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return result.status === 0;
};

const renderMigrationWarning = (findings: ReadonlyArray<MigrationFinding>): string =>
  [
    "",
    "!! This merge brings new upstream migrations:",
    ...findings.map(
      (finding) =>
        `   - ${finding.path} [${finding.risk}]${
          finding.collidesWith ? ` collides with ${finding.collidesWith.path}` : ""
        }`,
    ),
    "   Read apps/server/src/persistence/MigrationLedger.ts before you trust the numbering,",
    "   and never run the merged server against ~/.t3/userdata to find out.",
  ].join("\n");

const main = () => {
  assertPreconditions();

  if (!values["no-fetch"]) {
    log(`Fetching ${upstreamRemote}/${values["upstream-branch"]}…`);
    git(repoRoot, "fetch", "--no-tags", upstreamRemote, values["upstream-branch"]);
  }

  const base = resolveRef(repoRoot, values.base);
  const upstream = resolveRef(repoRoot, upstreamRef);
  const preMergeDrift = measureDrift(repoRoot, base.sha, upstream.sha);

  if (preMergeDrift.behind === 0) {
    log(`${base.ref} is already up to date with ${upstream.ref}. Nothing to merge.`);
    return;
  }

  if (values["dry-run"]) {
    log(
      renderDriftMarkdown(
        collectDriftReport({ cwd: repoRoot, base: values.base, upstream: upstreamRef }),
      ),
    );
    log(`Dry run: would branch \`${values.branch ?? datedBranchName()}\` off ${base.ref}.`);
    return;
  }

  const branch = values.branch ?? datedBranchName();
  if (tryGit(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).status === 0) {
    refuse(`branch "${branch}" already exists. Delete it or pass --branch <name>.`);
  }

  log(
    `Branching ${branch} off ${base.ref} (${preMergeDrift.behind} commits behind ${upstream.ref})…`,
  );
  git(repoRoot, "switch", "-c", branch, base.sha);

  const merge = tryGit(repoRoot, "merge", "--no-ff", "--no-edit", upstream.sha);

  const migrations = analyzeMigrations({
    baseMigrations: listMigrations(repoRoot, base.sha),
    upstreamMigrations: listMigrations(repoRoot, upstream.sha),
    mergeBaseMigrations: listMigrations(repoRoot, preMergeDrift.mergeBase),
    upstreamChangedFiles: listUpstreamChangedFiles(repoRoot, preMergeDrift.mergeBase, upstream.sha),
  });

  if (merge.status !== 0) {
    const conflicted = git(repoRoot, "diff", "--name-only", "--diff-filter=U", "-z")
      .split("\0")
      .filter(Boolean);
    if (conflicted.length === 0) {
      // Not a conflict: git refused the merge outright. Its own words are the
      // only useful thing here.
      log(`\nMerge failed on ${branch} without leaving conflicts:`);
      log(`${merge.stdout}${merge.stderr}`.trim());
      log(`\nTo walk away: git switch ${base.ref} && git branch -D ${branch}`);
      process.exit(EXIT_CONFLICTS);
    }
    log(
      `\nMerge stopped with ${conflicted.length} conflicting files, left in the tree on ${branch}:`,
    );
    for (const file of conflicted) log(`   - ${file}`);
    if (conflicted.includes(WORKSPACE_FILE)) {
      log(
        `\n!! ${WORKSPACE_FILE} conflicts. Keep the fork's allowBuilds values — upstream's` +
          `\n   "${WORKSPACE_PLACEHOLDER}" placeholder breaks vp i.`,
      );
    }
    if (migrations.findings.length > 0) log(renderMigrationWarning(migrations.findings));
    log(
      "\nResolve them yourself, then `git add` and `git commit`." +
        "\nTo walk away: git merge --abort && git switch " +
        base.ref +
        ` && git branch -D ${branch}`,
    );
    process.exit(EXIT_CONFLICTS);
  }

  const changedFiles = git(repoRoot, "diff", "--name-only", "-z", base.sha, "HEAD")
    .split("\0")
    .filter(Boolean);
  const packages = affectedPackages(changedFiles);

  log(`\nMerged clean: ${changedFiles.length} files changed across ${packages.length} packages.`);
  if (migrations.findings.length > 0) log(renderMigrationWarning(migrations.findings));

  if (changedFiles.includes(WORKSPACE_FILE)) {
    const merged = NodeFS.readFileSync(NodePath.join(repoRoot, WORKSPACE_FILE), "utf8");
    log(
      merged.includes(WORKSPACE_PLACEHOLDER)
        ? `\n!! ${WORKSPACE_FILE} merged back upstream's "${WORKSPACE_PLACEHOLDER}" placeholder.` +
            "\n   Fix it before running vp i — the install fails on it."
        : `\n${WORKSPACE_FILE} changed. Re-run vp i before trusting a build.`,
    );
  }

  if (values["skip-checks"]) {
    log("\nSkipping checks (--skip-checks). Affected packages:");
    for (const workspacePackage of packages) log(`   - ${workspacePackage.dir}`);
    return;
  }

  const failures: Array<string> = [];
  for (const workspacePackage of packages) {
    for (const script of workspacePackage.scripts) {
      if (!runScopedCheck(workspacePackage, script)) {
        failures.push(`${workspacePackage.dir} ${script}`);
      }
    }
  }

  log(`\nBranch ${branch} is ready. Nothing was pushed.`);
  if (failures.length === 0) {
    log(`Scoped checks passed for ${packages.length} packages.`);
    return;
  }
  log(`Scoped checks failed: ${failures.join(", ")}`);
  process.exit(EXIT_CHECKS_FAILED);
};

try {
  main();
} catch (error) {
  // Git's failures are expected input here (no merge base, unreachable remote,
  // a ref that moved). Report them as a refusal, not as a crashed script.
  process.stderr.write(
    `sync:upstream failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(EXIT_REFUSED);
}
