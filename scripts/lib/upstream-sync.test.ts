// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway git repositories on disk to test the dependency-free module.
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  collectDriftReport,
  git,
  measureDrift,
  parseMigrationPath,
  renderDriftMarkdown,
  resolveRef,
  WORKSPACE_PLACEHOLDER,
} from "./upstream-sync.ts";

/**
 * These run against real repositories rather than canned git output: the
 * behaviors worth protecting — conflict detection and migration collisions —
 * are git's own, and a fixture would only prove the parser matches the fixture.
 */
const MIGRATIONS = "apps/server/src/persistence/Migrations";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop()!;
    NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

const write = (dir: string, file: string, content: string) => {
  const target = NodePath.join(dir, file);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, content, "utf8");
};

const commit = (dir: string, message: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
};

const onBranch = (dir: string, branch: string, change: () => void) => {
  git(dir, "switch", "--quiet", branch);
  change();
};

/**
 * A fork/upstream pair: `firstmate` carries the fork's work, `upstream-main`
 * stands in for `upstream/main`, and both descend from one shared commit.
 */
const createRepository = (): string => {
  const dir = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-")),
  );
  temporaryDirectories.push(dir);
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.email", "sync-test@example.com");
  git(dir, "config", "user.name", "Sync Test");
  git(dir, "config", "commit.gpgsign", "false");

  write(dir, "README.md", "shared\n");
  write(dir, `${MIGRATIONS}/052_ProjectionThreadTitleState.ts`, "export default 52;\n");
  write(
    dir,
    "pnpm-workspace.yaml",
    `packages:\n  - apps/*\n\nallowBuilds:\n  msgpackr-extract: ${WORKSPACE_PLACEHOLDER}\n`,
  );
  commit(dir, "shared history");
  git(dir, "branch", "firstmate");
  git(dir, "branch", "upstream-main");
  return dir;
};

const reportOf = (dir: string) =>
  collectDriftReport({ cwd: dir, base: "firstmate", upstream: "upstream-main" });

describe("upstream-sync", () => {
  it("counts drift in both directions", () => {
    const dir = createRepository();
    onBranch(dir, "firstmate", () => {
      write(dir, "fork.ts", "fork\n");
      commit(dir, "fork work");
    });
    onBranch(dir, "upstream-main", () => {
      write(dir, "upstream-a.ts", "a\n");
      commit(dir, "upstream a");
      write(dir, "upstream-b.ts", "b\n");
      commit(dir, "upstream b");
    });

    const drift = measureDrift(dir, "firstmate", "upstream-main");
    assert.equal(drift.ahead, 1);
    assert.equal(drift.behind, 2);
  });

  it("calls a sync cheap when the two sides touch different files", () => {
    const dir = createRepository();
    onBranch(dir, "firstmate", () => {
      write(dir, "fork.ts", "fork\n");
      commit(dir, "fork work");
    });
    onBranch(dir, "upstream-main", () => {
      write(dir, "upstream.ts", "upstream\n");
      commit(dir, "upstream work");
    });

    const report = reportOf(dir);
    assert.equal(report.cost, "cheap");
    assert.isTrue(report.merge.clean);
    assert.deepEqual(
      report.commits.map((entry) => entry.subject),
      ["upstream work"],
    );
  });

  it("names the conflicting files and how they conflict", () => {
    const dir = createRepository();
    onBranch(dir, "firstmate", () => {
      write(dir, "README.md", "fork edit\n");
      commit(dir, "fork edit");
    });
    onBranch(dir, "upstream-main", () => {
      write(dir, "README.md", "upstream edit\n");
      commit(dir, "upstream edit");
    });

    const report = reportOf(dir);
    assert.equal(report.cost, "expensive");
    assert.isFalse(report.merge.clean);
    assert.deepEqual(
      report.merge.conflicts.map((conflict) => conflict.path),
      ["README.md"],
    );
    // Git's own label, parsed out of the informational records rather than guessed.
    assert.notEqual(report.merge.conflicts[0]?.kind, "unknown");
  });

  it("reports the workspace placeholder coming back from upstream", () => {
    const dir = createRepository();
    onBranch(dir, "firstmate", () => {
      write(
        dir,
        "pnpm-workspace.yaml",
        "packages:\n  - apps/*\n\nallowBuilds:\n  msgpackr-extract: true\n",
      );
      commit(dir, "fix allowBuilds for the fork");
    });
    onBranch(dir, "upstream-main", () => {
      write(
        dir,
        "pnpm-workspace.yaml",
        `packages:\n  - apps/*\n  - packages/*\n\nallowBuilds:\n  msgpackr-extract: ${WORKSPACE_PLACEHOLDER}\n`,
      );
      commit(dir, "add a workspace glob");
    });

    // The edits sit far enough apart that git merges them, so the warning has
    // to come from upstream still carrying the placeholder — not from a conflict.
    const report = reportOf(dir);
    assert.isTrue(report.merge.clean);
    assert.isTrue(report.workspace.placeholderInUpstream);
    assert.isTrue(report.workspace.changedByUpstream);
    assert.include(renderDriftMarkdown(report), WORKSPACE_PLACEHOLDER);
  });

  it("flags a new upstream migration even when the merge is clean", () => {
    const dir = createRepository();
    onBranch(dir, "upstream-main", () => {
      write(dir, `${MIGRATIONS}/054_ProjectionSomething.ts`, "export default 54;\n");
      write(dir, `${MIGRATIONS}/054_ProjectionSomething.test.ts`, "// test\n");
      commit(dir, "add migration 054");
    });

    const report = reportOf(dir);
    assert.isTrue(report.merge.clean);
    assert.equal(report.cost, "expensive");
    assert.deepEqual(
      report.migrations.findings.map((finding) => [finding.id, finding.risk]),
      [[54, "new"]],
    );
  });

  it("flags an id upstream claims that a fork-only migration already holds", () => {
    const dir = createRepository();
    onBranch(dir, "firstmate", () => {
      write(dir, `${MIGRATIONS}/054_ForkOnlyThing.ts`, "export default 54;\n");
      commit(dir, "fork migration numbered into upstream's lane");
    });
    onBranch(dir, "upstream-main", () => {
      write(dir, `${MIGRATIONS}/054_UpstreamThing.ts`, "export default 54;\n");
      commit(dir, "upstream migration 054");
    });

    const finding = reportOf(dir).migrations.findings[0];
    assert.equal(finding?.risk, "collision");
    assert.equal(finding?.collidesWith?.path, `${MIGRATIONS}/054_ForkOnlyThing.ts`);
  });

  it("flags upstream numbering into the fork's reserved range", () => {
    const dir = createRepository();
    onBranch(dir, "upstream-main", () => {
      write(dir, `${MIGRATIONS}/900_UpstreamWentHigh.ts`, "export default 900;\n");
      commit(dir, "upstream migration 900");
    });

    const finding = reportOf(dir).migrations.findings[0];
    assert.equal(finding?.risk, "reserved-range");
  });

  it("reports being in sync without listing commits", () => {
    const dir = createRepository();
    onBranch(dir, "firstmate", () => {
      write(dir, "fork.ts", "fork\n");
      commit(dir, "fork work");
    });

    const report = reportOf(dir);
    assert.equal(report.cost, "in-sync");
    assert.equal(report.drift.behind, 0);
    assert.deepEqual(report.commits, []);
  });

  it("resolves a branch that only exists as a remote-tracking ref", () => {
    const dir = createRepository();
    const sha = git(dir, "rev-parse", "firstmate").trim();
    git(dir, "update-ref", "refs/remotes/origin/only-remote", sha);

    assert.equal(resolveRef(dir, "only-remote").ref, "origin/only-remote");
    assert.throws(() => resolveRef(dir, "nowhere"), /Cannot resolve "nowhere"/);
  });

  it("recognizes migration modules and ignores their tests", () => {
    assert.deepEqual(parseMigrationPath(`${MIGRATIONS}/053_PullRequestFilesViewed.ts`), {
      id: 53,
      name: "PullRequestFilesViewed",
      path: `${MIGRATIONS}/053_PullRequestFilesViewed.ts`,
    });
    assert.isUndefined(parseMigrationPath(`${MIGRATIONS}/053_PullRequestFilesViewed.test.ts`));
    assert.isUndefined(parseMigrationPath("apps/server/src/persistence/MigrationLedger.ts"));
  });
});
