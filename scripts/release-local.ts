#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Dependency-free on purpose; see scripts/lib/upstream-sync.ts.
/**
 * Build a local desktop release the installed app can actually update to.
 *
 * Three things have to line up before the in-app update button appears, and
 * missing any one of them fails silently:
 *
 * 1. A publish config at build time. Without it electron-builder emits no
 *    `latest.yml` and bakes no `app-update.yml`, so the app reports "no update
 *    feed is configured" and never polls. `--mock-updates` supplies a generic
 *    provider pointing at the local server.
 * 2. A version higher than the installed one. electron-updater compares
 *    versions; rebuilding the same number offers nothing, however correct the
 *    feed is.
 * 3. The server serving `release-mock/` on the port the build was pointed at.
 *
 * This script owns 1 and 2. Start the server with `vp run start:mock-update-server`.
 *
 * Deliberately dependency-free (node builtins only), matching
 * `scripts/lib/upstream-sync.ts`: it must run before install in a fresh clone.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const releaseMockDir = NodePath.join(repoRoot, "release-mock");

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(raw: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function compareVersions(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * The highest version already published to the local feed, so repeated runs
 * keep climbing without editing `apps/desktop/package.json`. A dirty version
 * bump in the repo would show up in every diff and every upstream merge.
 */
function publishedVersion(): Version | null {
  const manifest = NodePath.join(releaseMockDir, "latest.yml");
  if (!NodeFS.existsSync(manifest)) return null;
  const line = NodeFS.readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("version:"));
  return line ? parseVersion(line.slice("version:".length)) : null;
}

function packageVersion(): Version {
  const raw = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/desktop/package.json"), "utf8"),
  ) as {
    version?: string;
  };
  const parsed = raw.version ? parseVersion(raw.version) : null;
  if (!parsed) {
    throw new Error("apps/desktop/package.json has no parsable version.");
  }
  return parsed;
}

function nextVersion(): string {
  const published = publishedVersion();
  const base = packageVersion();
  const highest = published && compareVersions(published, base) > 0 ? published : base;
  return formatVersion({ ...highest, patch: highest.patch + 1 });
}

function main(): number {
  const args = process.argv.slice(2);
  const explicit = args.find((arg) => arg.startsWith("--build-version="));
  const version = explicit ? explicit.slice("--build-version=".length) : nextVersion();
  if (!parseVersion(version)) {
    process.stderr.write(`Not a version: ${version}`);
    return 1;
  }

  // Platform and target are left to build-desktop-artifact, which already
  // defaults them from the host. Only the flavour is opinionated here.
  const passthrough = args.filter((arg) => !arg.startsWith("--build-version="));
  const flavor = passthrough.includes("--flavor") ? [] : ["--flavor", "firstmate"];

  process.stdout.write(`Building ${version} into release-mock/ with the local update feed.\n`);
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(repoRoot, "scripts/build-desktop-artifact.ts"),
      ...flavor,
      "--mock-updates",
      "--build-version",
      version,
      ...passthrough,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) return result.status ?? 1;

  process.stdout.write(
    [
      "",
      `Published ${version} to release-mock/.`,
      "Serve it with: vp run start:mock-update-server",
      "The installed app only sees this if it was itself built with --mock-updates.",
      "",
    ].join("\n"),
  );
  return 0;
}

process.exit(main());
