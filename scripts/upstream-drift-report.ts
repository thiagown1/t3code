#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Dependency-free on purpose; see scripts/lib/upstream-sync.ts.

/**
 * Read-only upstream drift report, written for the daily workflow
 * (`.github/workflows/upstream-drift.yml`) but runnable by hand:
 *
 *   node scripts/upstream-drift-report.ts --base firstmate --upstream upstream/main
 *
 * It never merges, never moves a ref, and never touches the working tree — see
 * `scripts/lib/upstream-sync.ts`. It prints Markdown, and, under Actions, also
 * appends to the step summary and publishes scalars for the issue-upsert step.
 *
 * Node builtins only, on purpose: the workflow runs it without a pnpm install.
 */

import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import {
  collectDriftReport,
  driftFingerprint,
  renderDriftMarkdown,
  renderDriftTitle,
  DEFAULT_BASE_REF,
  DEFAULT_UPSTREAM_REF,
} from "./lib/upstream-sync.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    base: { type: "string", default: DEFAULT_BASE_REF },
    upstream: { type: "string", default: DEFAULT_UPSTREAM_REF },
    cwd: { type: "string", default: process.cwd() },
    "commit-limit": { type: "string", default: "15" },
    out: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const report = collectDriftReport({
  cwd: values.cwd,
  base: values.base,
  upstream: values.upstream,
  commitLimit: Number(values["commit-limit"]),
});

const markdown = renderDriftMarkdown(report);
const title = renderDriftTitle(report);

process.stdout.write(values.json ? `${JSON.stringify(report, undefined, 2)}\n` : `${markdown}\n`);

if (values.out) NodeFS.writeFileSync(values.out, markdown, "utf8");

const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
if (summaryPath) NodeFS.appendFileSync(summaryPath, `# ${title}\n\n${markdown}\n`, "utf8");

const outputPath = process.env["GITHUB_OUTPUT"];
if (outputPath) {
  const outputs: Record<string, string> = {
    cost: report.cost,
    title,
    behind: String(report.drift.behind),
    ahead: String(report.drift.ahead),
    conflicts: String(report.merge.conflicts.length),
    migrations: String(report.migrations.findings.length),
    fingerprint: driftFingerprint(report),
  };
  NodeFS.appendFileSync(
    outputPath,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    "utf8",
  );
}

// The report is advisory. An expensive sync is news, not a broken build.
process.exitCode = 0;
