// @effect-diagnostics nodeBuiltinImport:off - Dependency-free on purpose: the daily workflow runs this straight from a checkout, with no install and so no Effect.
/**
 * Shared analysis behind the two upstream-sync entry points: the daily drift
 * workflow (`scripts/upstream-drift-report.ts`) and the local merge driver
 * (`scripts/sync-upstream.ts`). One module so "is the sync cheap or expensive"
 * is answered the same way in CI and on a laptop.
 *
 * Deliberately dependency-free — only `node:` builtins. The workflow runs it
 * straight out of a checkout with `node scripts/...`, so a daily drift check
 * costs a fetch instead of a full monorepo install. Keep it that way: an Effect
 * import here turns the workflow into a `pnpm install` job.
 *
 * Nothing in here writes a ref, moves a branch, or touches the working tree.
 * The merge is probed with `git merge-tree`, which only writes loose objects.
 */

import * as NodeChildProcess from "node:child_process";

export const DEFAULT_BASE_REF = "firstmate";
export const DEFAULT_UPSTREAM_REMOTE = "upstream";
export const DEFAULT_UPSTREAM_REF = "upstream/main";
export const UPSTREAM_REPOSITORY_URL = "https://github.com/pingdotgg/t3code.git";

const MIGRATIONS_PREFIX = "apps/server/src/persistence/Migrations/";

/** Files that decide which migration id lands where. Upstream edits are worth a look. */
const MIGRATION_LEDGER_FILES = [
  "apps/server/src/persistence/MigrationLedger.ts",
  "apps/server/src/persistence/Migrations.ts",
];

/**
 * Mirrors `FORK_MIGRATION_ID_FLOOR` in apps/server/src/persistence/MigrationLedger.ts.
 * Duplicated rather than imported because this module must stay importable
 * without the server's dependency graph.
 */
export const FORK_MIGRATION_ID_FLOOR = 900;

export const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** Upstream's unresolved `allowBuilds` entry. Merged back in, it breaks `vp i`. */
export const WORKSPACE_PLACEHOLDER = "set this to true or false";

export interface GitOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class GitCommandError extends Error {
  // Plain fields, not parameter properties: Node runs this module by stripping
  // types, which rules out any syntax that emits code.
  readonly args: ReadonlyArray<string>;
  readonly outcome: GitOutcome;

  constructor(args: ReadonlyArray<string>, outcome: GitOutcome) {
    super(
      `git ${args.join(" ")} failed with status ${outcome.status}${
        outcome.stderr.trim() ? `: ${outcome.stderr.trim()}` : ""
      }`,
    );
    this.name = "GitCommandError";
    this.args = args;
    this.outcome = outcome;
  }
}

/** Runs git and hands back the outcome, including failures. */
export const tryGit = (cwd: string, ...args: ReadonlyArray<string>): GitOutcome => {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new GitCommandError(args, { status: -1, stdout: "", stderr: String(result.error) });
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** Runs git, throwing on anything but success. */
export const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const outcome = tryGit(cwd, ...args);
  if (outcome.status !== 0) throw new GitCommandError(args, outcome);
  return outcome.stdout;
};

const splitNul = (value: string): ReadonlyArray<string> =>
  value.split("\0").filter((entry) => entry.length > 0);

export interface ResolvedRef {
  readonly ref: string;
  readonly sha: string;
}

/**
 * Resolves a branch name that may only exist as a remote-tracking ref — the
 * usual shape in a CI checkout, where `firstmate` arrives as `origin/firstmate`.
 */
export const resolveRef = (cwd: string, ref: string): ResolvedRef => {
  const candidates = ref.includes("/") ? [ref] : [ref, `origin/${ref}`];
  for (const candidate of candidates) {
    const outcome = tryGit(cwd, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
    if (outcome.status === 0) return { ref: candidate, sha: outcome.stdout.trim() };
  }
  throw new Error(`Cannot resolve "${ref}". Tried: ${candidates.join(", ")}.`);
};

export interface Drift {
  readonly ahead: number;
  readonly behind: number;
  readonly mergeBase: string;
}

/** Commits the fork carries that upstream lacks (`ahead`), and the reverse (`behind`). */
export const measureDrift = (cwd: string, base: string, upstream: string): Drift => {
  const counts = git(cwd, "rev-list", "--left-right", "--count", `${base}...${upstream}`)
    .trim()
    .split(/\s+/)
    .map(Number);
  const [ahead = 0, behind = 0] = counts;
  return { ahead, behind, mergeBase: git(cwd, "merge-base", base, upstream).trim() };
};

export interface UpstreamCommit {
  readonly sha: string;
  readonly subject: string;
}

export const listUpstreamCommits = (
  cwd: string,
  base: string,
  upstream: string,
  limit: number,
): ReadonlyArray<UpstreamCommit> =>
  git(
    cwd,
    "log",
    "--no-merges",
    `--max-count=${limit}`,
    "--format=%h%x00%s%x00",
    `${base}..${upstream}`,
  )
    .split("\0")
    .reduce<Array<UpstreamCommit>>((commits, entry, index, entries) => {
      if (index % 2 !== 0) return commits;
      const sha = entry.replace(/^\n/, "").trim();
      const subject = entries[index + 1];
      if (sha && subject !== undefined) commits.push({ sha, subject });
      return commits;
    }, []);

export interface MergeConflict {
  readonly path: string;
  /** Git's own label: `content`, `modify/delete`, `rename/rename`, ... */
  readonly kind: string;
}

export interface MergeAnalysis {
  readonly clean: boolean;
  readonly tree: string;
  readonly conflicts: ReadonlyArray<MergeConflict>;
}

const conflictKindOf = (messageType: string): string | undefined =>
  /^CONFLICT \((.+)\)$/.exec(messageType)?.[1];

/**
 * Parses `git merge-tree --write-tree --name-only -z` output.
 *
 * Three sections separated by an empty entry: the merged tree oid, the
 * conflicted paths, then informational records shaped as
 * `<path count>, <path>…, <message type>, <message>`. The records are what
 * turn a bare path into "content" versus "modify/delete".
 */
export const parseMergeTree = (stdout: string): MergeAnalysis => {
  const entries = stdout.split("\0");
  const tree = (entries[0] ?? "").trim();

  let index = 1;
  const paths: Array<string> = [];
  while (index < entries.length && entries[index] !== "") {
    paths.push(entries[index]!);
    index += 1;
  }
  index += 1;

  const kinds = new Map<string, string>();
  while (index < entries.length && entries[index] !== "" && entries[index] !== undefined) {
    const count = Number(entries[index]);
    if (!Number.isInteger(count) || count < 0) break;
    const recordPaths = entries.slice(index + 1, index + 1 + count);
    const kind = conflictKindOf(entries[index + 1 + count] ?? "");
    index += count + 3;
    if (kind === undefined) continue;
    for (const path of recordPaths) kinds.set(path, kind);
  }

  return {
    clean: paths.length === 0,
    tree,
    conflicts: paths.map((path) => ({ path, kind: kinds.get(path) ?? "unknown" })),
  };
};

/**
 * Probes the merge without committing, checking out, or moving a ref. Exit code
 * 1 means conflicts; anything above that is a real git failure.
 */
export const analyzeMerge = (cwd: string, base: string, upstream: string): MergeAnalysis => {
  const args = ["merge-tree", "--write-tree", "--name-only", "-z", base, upstream];
  const outcome = tryGit(cwd, ...args);
  if (outcome.status !== 0 && outcome.status !== 1) throw new GitCommandError(args, outcome);
  return parseMergeTree(outcome.stdout);
};

export interface MigrationFile {
  readonly id: number;
  readonly name: string;
  readonly path: string;
}

/** Recognizes `NNN_Name.ts` migration modules, ignoring their colocated tests. */
export const parseMigrationPath = (path: string): MigrationFile | undefined => {
  if (!path.startsWith(MIGRATIONS_PREFIX)) return undefined;
  const file = path.slice(MIGRATIONS_PREFIX.length);
  if (file.includes("/") || file.endsWith(".test.ts")) return undefined;
  const match = /^(\d{3,})_(.+)\.ts$/.exec(file);
  if (!match) return undefined;
  return { id: Number(match[1]), name: match[2]!, path };
};

export const listMigrations = (cwd: string, ref: string): ReadonlyArray<MigrationFile> =>
  splitNul(git(cwd, "ls-tree", "-r", "--name-only", "-z", ref, "--", MIGRATIONS_PREFIX))
    .map(parseMigrationPath)
    .filter((migration): migration is MigrationFile => migration !== undefined)
    .sort((left, right) => left.id - right.id);

/**
 * `reserved-range` means upstream numbered into the fork's 900+ lane, and
 * `collision` means it claimed an id a fork-only migration already holds.
 * Either one is the failure that nearly ate a developer's database; `new` is
 * the benign case that still wants a ledger read before merging.
 */
export type MigrationRisk = "reserved-range" | "collision" | "new";

export interface MigrationFinding extends MigrationFile {
  readonly risk: MigrationRisk;
  readonly collidesWith?: MigrationFile;
}

export interface MigrationAnalysis {
  readonly findings: ReadonlyArray<MigrationFinding>;
  readonly ledgerFilesTouched: ReadonlyArray<string>;
}

export const analyzeMigrations = (input: {
  readonly baseMigrations: ReadonlyArray<MigrationFile>;
  readonly upstreamMigrations: ReadonlyArray<MigrationFile>;
  readonly mergeBaseMigrations: ReadonlyArray<MigrationFile>;
  readonly upstreamChangedFiles: ReadonlyArray<string>;
}): MigrationAnalysis => {
  const knownPaths = new Set(input.mergeBaseMigrations.map((migration) => migration.path));
  const upstreamPaths = new Set(input.upstreamMigrations.map((migration) => migration.path));
  const forkOnlyById = new Map(
    input.baseMigrations
      .filter((migration) => !upstreamPaths.has(migration.path))
      .map((migration) => [migration.id, migration] as const),
  );

  const findings = input.upstreamMigrations
    .filter((migration) => !knownPaths.has(migration.path))
    .map((migration): MigrationFinding => {
      const collidesWith = forkOnlyById.get(migration.id);
      const risk: MigrationRisk =
        migration.id >= FORK_MIGRATION_ID_FLOOR
          ? "reserved-range"
          : collidesWith
            ? "collision"
            : "new";
      return collidesWith ? { ...migration, risk, collidesWith } : { ...migration, risk };
    });

  return {
    findings,
    ledgerFilesTouched: MIGRATION_LEDGER_FILES.filter((file) =>
      input.upstreamChangedFiles.includes(file),
    ),
  };
};

export interface WorkspaceAnalysis {
  readonly changedByUpstream: boolean;
  readonly conflicted: boolean;
  /** True when upstream's copy still carries the unresolved `allowBuilds` entry. */
  readonly placeholderInUpstream: boolean;
}

export const readFileAtRef = (cwd: string, ref: string, path: string): string => {
  const outcome = tryGit(cwd, "show", `${ref}:${path}`);
  return outcome.status === 0 ? outcome.stdout : "";
};

export const listUpstreamChangedFiles = (
  cwd: string,
  mergeBase: string,
  upstream: string,
): ReadonlyArray<string> => splitNul(git(cwd, "diff", "--name-only", "-z", mergeBase, upstream));

/** "Cheap" means it merges clean and adds no migration; anything else wants a human first. */
export type SyncCost = "in-sync" | "cheap" | "expensive";

export interface DriftReport {
  readonly base: ResolvedRef;
  readonly upstream: ResolvedRef;
  readonly drift: Drift;
  readonly merge: MergeAnalysis;
  readonly migrations: MigrationAnalysis;
  readonly workspace: WorkspaceAnalysis;
  readonly commits: ReadonlyArray<UpstreamCommit>;
  readonly cost: SyncCost;
}

export const collectDriftReport = (options: {
  readonly cwd: string;
  readonly base?: string;
  readonly upstream?: string;
  readonly commitLimit?: number;
}): DriftReport => {
  const { cwd } = options;
  const base = resolveRef(cwd, options.base ?? DEFAULT_BASE_REF);
  const upstream = resolveRef(cwd, options.upstream ?? DEFAULT_UPSTREAM_REF);
  const drift = measureDrift(cwd, base.sha, upstream.sha);
  const merge = analyzeMerge(cwd, base.sha, upstream.sha);
  const upstreamChangedFiles = listUpstreamChangedFiles(cwd, drift.mergeBase, upstream.sha);
  const migrations = analyzeMigrations({
    baseMigrations: listMigrations(cwd, base.sha),
    upstreamMigrations: listMigrations(cwd, upstream.sha),
    mergeBaseMigrations: listMigrations(cwd, drift.mergeBase),
    upstreamChangedFiles,
  });
  const conflictPaths = merge.conflicts.map((conflict) => conflict.path);
  const workspace: WorkspaceAnalysis = {
    changedByUpstream: upstreamChangedFiles.includes(WORKSPACE_FILE),
    conflicted: conflictPaths.includes(WORKSPACE_FILE),
    placeholderInUpstream: readFileAtRef(cwd, upstream.sha, WORKSPACE_FILE).includes(
      WORKSPACE_PLACEHOLDER,
    ),
  };

  return {
    base,
    upstream,
    drift,
    merge,
    migrations,
    workspace,
    commits:
      drift.behind === 0
        ? []
        : listUpstreamCommits(cwd, base.sha, upstream.sha, options.commitLimit ?? 15),
    cost:
      drift.behind === 0
        ? "in-sync"
        : merge.clean && migrations.findings.length === 0
          ? "cheap"
          : "expensive",
  };
};

export const renderDriftTitle = (report: DriftReport): string => {
  if (report.cost === "in-sync") return "Upstream sync: in sync";
  const parts = [`${report.drift.behind} behind`];
  if (report.migrations.findings.length > 0) {
    parts.push(
      `${report.migrations.findings.length} new migration${
        report.migrations.findings.length === 1 ? "" : "s"
      }`,
    );
  }
  parts.push(
    report.merge.clean ? "merges clean" : `${report.merge.conflicts.length} conflicting files`,
  );
  return `Upstream sync: ${parts.join(", ")}`;
};

/**
 * A stable digest of everything worth waking someone up for. The workflow
 * compares it against the last published one so a quiet day stays quiet.
 */
export const driftFingerprint = (report: DriftReport): string =>
  JSON.stringify({
    cost: report.cost,
    conflicts: report.merge.conflicts.map((conflict) => conflict.path).sort(),
    migrations: report.migrations.findings
      .map((finding) => `${finding.risk}:${finding.path}`)
      .sort(),
    workspace: report.workspace.placeholderInUpstream || report.workspace.conflicted,
  });

const MIGRATION_RISK_NOTES: Record<MigrationRisk, string> = {
  "reserved-range": `upstream numbered into the fork's reserved ${FORK_MIGRATION_ID_FLOOR}+ lane — do not merge before renumbering`,
  collision: "claims an id a fork-only migration already holds",
  new: "new upstream migration — read MigrationLedger.ts before merging",
};

export const renderDriftMarkdown = (report: DriftReport): string => {
  const lines: Array<string> = [];
  const headline =
    report.cost === "in-sync"
      ? "**In sync.** Nothing to merge from upstream."
      : report.cost === "cheap"
        ? "**Cheap sync.** Merges clean, no new upstream migration."
        : "**Expensive sync.** Needs a human before merging — see below.";

  lines.push(headline, "");
  lines.push(
    `| | |`,
    `| --- | --- |`,
    `| Fork branch | \`${report.base.ref}\` (\`${report.base.sha.slice(0, 9)}\`) |`,
    `| Upstream | \`${report.upstream.ref}\` (\`${report.upstream.sha.slice(0, 9)}\`) |`,
    `| Drift | ${report.drift.behind} behind, ${report.drift.ahead} ahead |`,
    `| Merge | ${report.merge.clean ? "clean" : `${report.merge.conflicts.length} conflicting files`} |`,
    "",
  );

  if (report.migrations.findings.length > 0) {
    lines.push("## New upstream migrations", "");
    lines.push(
      "The fork reserves ids from " +
        `${FORK_MIGRATION_ID_FLOOR} up (\`apps/server/src/persistence/MigrationLedger.ts\`). ` +
        "Upstream keeps the low ids. A migration that breaks that split can corrupt a developer's database.",
      "",
    );
    for (const finding of report.migrations.findings) {
      const collision = finding.collidesWith
        ? ` (fork holds \`${finding.collidesWith.path}\`)`
        : "";
      lines.push(
        `- \`${finding.path}\` — **${finding.risk}**: ${MIGRATION_RISK_NOTES[finding.risk]}${collision}`,
      );
    }
    lines.push("");
  }

  if (report.migrations.ledgerFilesTouched.length > 0) {
    lines.push(
      `Upstream also touched ${report.migrations.ledgerFilesTouched
        .map((file) => `\`${file}\``)
        .join(", ")}.`,
      "",
    );
  }

  if (report.workspace.placeholderInUpstream) {
    lines.push(
      `## \`${WORKSPACE_FILE}\``,
      "",
      `Upstream still carries the \`${WORKSPACE_PLACEHOLDER}\` placeholder, which breaks \`vp i\`. The fork's \`allowBuilds\` value has to survive the merge — check it before installing.`,
      "",
    );
  } else if (report.workspace.conflicted) {
    lines.push(
      `## \`${WORKSPACE_FILE}\``,
      "",
      "Conflicts here. Keep the fork's `allowBuilds` resolution.",
      "",
    );
  }

  if (!report.merge.clean) {
    lines.push("## Conflicting files", "");
    for (const conflict of report.merge.conflicts) {
      lines.push(`- \`${conflict.path}\` (${conflict.kind})`);
    }
    lines.push("");
  }

  if (report.commits.length > 0) {
    lines.push(
      "<details><summary>Newest upstream commits</summary>",
      "",
      ...report.commits.map((commit) => `- \`${commit.sha}\` ${commit.subject}`),
      "",
      "</details>",
      "",
    );
  }

  if (report.cost !== "in-sync") {
    lines.push("Run `vp run sync:upstream` locally to prepare the merge branch.", "");
  }

  return lines.join("\n");
};
