import * as NodeCrypto from "node:crypto";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Toml from "effect/unstable/encoding/Toml";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { findEnvironmentBundleRepositoryRoot } from "./EnvironmentBundlePaths.ts";

const MAX_CODEX_CONFIG_BYTES = FileSystem.Size(1_000_000);
const MISSING_TARGET_MARKER = "t3-environment-bundle:missing";
const SKILL_CONFIG_HEADER =
  /^[\t ]*\[\[[\t ]*skills[\t ]*\.[\t ]*config[\t ]*\]\][\t ]*(?:#.*)?$/gmu;
const TABLE_HEADER = /^[\t ]*\[{1,2}[^\r\n]+?\]{1,2}[\t ]*(?:#.*)?$/gmu;

export class CodexSkillOverrideTargetError extends Data.TaggedError(
  "CodexSkillOverrideTargetError",
)<{
  readonly reason: "invalid-toml" | "too-large" | "state-changed" | "persistence-failed";
  readonly message: string;
}> {}

interface CodexSkillConfigEntry {
  readonly path: string;
  readonly enabled: boolean | undefined;
  readonly blockStart: number;
  readonly blockEnd: number;
  readonly pathLineEnd: number;
  readonly enabledValueStart: number | undefined;
  readonly enabledValueEnd: number | undefined;
}

export interface CodexSkillOverrideTargetState {
  readonly filePath: string;
  readonly exists: boolean;
  readonly contents: string;
  readonly stateHash: string;
  readonly entries: ReadonlyMap<string, CodexSkillConfigEntry>;
}

function normalizeSkillPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized;
}

function stateHash(exists: boolean, contents: string): string {
  return NodeCrypto.createHash("sha256")
    .update(exists ? `present\0${contents}` : MISSING_TARGET_MARKER)
    .digest("hex");
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function invalidToml(message: string): CodexSkillOverrideTargetError {
  return new CodexSkillOverrideTargetError({ reason: "invalid-toml", message });
}

function parsedSkillEntries(contents: string): ReadonlyArray<{
  readonly path: string;
  readonly enabled: boolean | undefined;
}> {
  if (contents.trim().length === 0) return [];
  let parsed: Readonly<Record<string, unknown>>;
  try {
    parsed = Toml.parse(contents);
  } catch {
    throw invalidToml("Codex project configuration is not valid TOML");
  }
  const skills = objectRecord(parsed.skills);
  if (!skills || !Object.hasOwn(skills, "config")) return [];
  if (!Array.isArray(skills.config)) {
    throw invalidToml("Codex project skill configuration must be an array of tables");
  }
  return skills.config.map((unknownEntry) => {
    const entry = objectRecord(unknownEntry);
    if (
      !entry ||
      typeof entry.path !== "string" ||
      entry.path.trim().length === 0 ||
      (Object.hasOwn(entry, "enabled") && typeof entry.enabled !== "boolean")
    ) {
      throw invalidToml(
        "Each Codex skill override must contain a path and optional boolean enabled",
      );
    }
    return {
      path: entry.path,
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
    };
  });
}

function parseEntries(contents: string): ReadonlyMap<string, CodexSkillConfigEntry> {
  const parsed = parsedSkillEntries(contents);
  const skillHeaders = [...contents.matchAll(SKILL_CONFIG_HEADER)];
  if (skillHeaders.length !== parsed.length) {
    throw invalidToml("Codex skill overrides must use [[skills.config]] array-table syntax");
  }
  const tableStarts = [...contents.matchAll(TABLE_HEADER)].map((match) => match.index);
  const entries = new Map<string, CodexSkillConfigEntry>();
  for (const [index, header] of skillHeaders.entries()) {
    const blockStart = header.index;
    const blockEnd = tableStarts.find((start) => start > blockStart) ?? contents.length;
    const bodyStart = blockStart + header[0].length;
    const body = contents.slice(bodyStart, blockEnd);
    const pathLine = /^[\t ]*path[\t ]*=[^\r\n]*(?:\r?\n|$)/mu.exec(body);
    if (!pathLine) {
      throw invalidToml("Codex skill override path must use a direct path assignment");
    }
    const enabledLine = /^[\t ]*enabled[\t ]*=[\t ]*(true|false)(?=[\t ]*(?:#.*)?$)/gimu.exec(body);
    const source = parsed[index]!;
    const key = normalizeSkillPath(source.path);
    if (entries.has(key)) {
      throw invalidToml(`Codex project configuration contains duplicate skill path ${source.path}`);
    }
    entries.set(key, {
      path: source.path,
      enabled: source.enabled,
      blockStart,
      blockEnd,
      pathLineEnd: bodyStart + pathLine.index + pathLine[0].length,
      enabledValueStart:
        enabledLine?.index === undefined
          ? undefined
          : bodyStart + enabledLine.index + enabledLine[0].indexOf(enabledLine[1]!),
      enabledValueEnd:
        enabledLine?.index === undefined
          ? undefined
          : bodyStart +
            enabledLine.index +
            enabledLine[0].indexOf(enabledLine[1]!) +
            enabledLine[1]!.length,
    });
  }
  return entries;
}

export const loadCodexSkillOverrideTargetState = Effect.fn("loadCodexSkillOverrideTargetState")(
  function* (cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* findEnvironmentBundleRepositoryRoot(cwd);
    const filePath = path.join(root, ".codex", "config.toml");
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return {
        filePath,
        exists: false,
        contents: "",
        stateHash: stateHash(false, ""),
        entries: new Map(),
      } satisfies CodexSkillOverrideTargetState;
    }
    const info = yield* fileSystem.stat(filePath).pipe(
      Effect.mapError(
        () =>
          new CodexSkillOverrideTargetError({
            reason: "persistence-failed",
            message: "Codex project configuration could not be inspected",
          }),
      ),
    );
    if (info.type !== "File" || info.size > MAX_CODEX_CONFIG_BYTES) {
      return yield* new CodexSkillOverrideTargetError({
        reason: "too-large",
        message: "Codex project configuration is not a regular file within the 1 MB safety limit",
      });
    }
    const contents = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        () =>
          new CodexSkillOverrideTargetError({
            reason: "persistence-failed",
            message: "Codex project configuration could not be read",
          }),
      ),
    );
    const entries = yield* Effect.try({
      try: () => parseEntries(contents),
      catch: (cause) =>
        cause instanceof CodexSkillOverrideTargetError
          ? cause
          : invalidToml("Codex project configuration could not be parsed"),
    });
    return {
      filePath,
      exists: true,
      contents,
      stateHash: stateHash(true, contents),
      entries,
    } satisfies CodexSkillOverrideTargetState;
  },
);

export function renderCodexSkillDisableOverrides(
  state: CodexSkillOverrideTargetState,
  skillPaths: ReadonlyArray<string>,
): string {
  const eol = state.contents.includes("\r\n") ? "\r\n" : "\n";
  const uniquePaths = new Map<string, string>();
  for (const skillPath of skillPaths) uniquePaths.set(normalizeSkillPath(skillPath), skillPath);
  const replacements: Array<{
    readonly start: number;
    readonly end: number;
    readonly value: string;
  }> = [];
  const additions: string[] = [];
  for (const [key, skillPath] of [...uniquePaths.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const existing = state.entries.get(key);
    if (!existing) {
      additions.push(
        `[[skills.config]]${eol}path = ${JSON.stringify(skillPath)}${eol}enabled = false${eol}`,
      );
      continue;
    }
    if (existing.enabled === false) continue;
    if (existing.enabledValueStart !== undefined && existing.enabledValueEnd !== undefined) {
      replacements.push({
        start: existing.enabledValueStart,
        end: existing.enabledValueEnd,
        value: "false",
      });
      continue;
    }
    replacements.push({
      start: existing.pathLineEnd,
      end: existing.pathLineEnd,
      value: `enabled = false${eol}`,
    });
  }
  let contents = state.contents;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    contents = `${contents.slice(0, replacement.start)}${replacement.value}${contents.slice(replacement.end)}`;
  }
  if (additions.length > 0) {
    if (contents.length > 0 && !contents.endsWith(eol)) contents += eol;
    if (contents.length > 0 && !contents.endsWith(`${eol}${eol}`)) contents += eol;
    contents += additions.join(eol);
  }
  if (contents.length > 0 && !contents.endsWith(eol)) contents += eol;
  parseEntries(contents);
  return contents;
}

export const writeCodexSkillDisableOverrides = Effect.fn("writeCodexSkillDisableOverrides")(
  function* (input: {
    readonly cwd: string;
    readonly expectedStateHash: string;
    readonly skillPaths: ReadonlyArray<string>;
  }) {
    const current = yield* loadCodexSkillOverrideTargetState(input.cwd);
    if (current.stateHash !== input.expectedStateHash) {
      return yield* new CodexSkillOverrideTargetError({
        reason: "state-changed",
        message: "Codex project configuration changed after the Environment Bundle dry run",
      });
    }
    const contents = yield* Effect.try({
      try: () => renderCodexSkillDisableOverrides(current, input.skillPaths),
      catch: (cause) =>
        cause instanceof CodexSkillOverrideTargetError
          ? cause
          : new CodexSkillOverrideTargetError({
              reason: "persistence-failed",
              message: "Codex skill disable overrides could not be rendered",
            }),
    });
    yield* writeFileStringAtomically({ filePath: current.filePath, contents }).pipe(
      Effect.mapError(
        () =>
          new CodexSkillOverrideTargetError({
            reason: "persistence-failed",
            message: "Codex project configuration could not be written atomically",
          }),
      ),
    );
    return {
      previous: current,
      written: {
        ...current,
        exists: true,
        contents,
        stateHash: stateHash(true, contents),
        entries: parseEntries(contents),
      } satisfies CodexSkillOverrideTargetState,
    };
  },
);

export const rollbackCodexSkillDisableOverrides = Effect.fn("rollbackCodexSkillDisableOverrides")(
  function* (input: {
    readonly cwd: string;
    readonly expectedWrittenStateHash: string;
    readonly previous: CodexSkillOverrideTargetState;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const current = yield* loadCodexSkillOverrideTargetState(input.cwd);
    if (
      current.filePath !== input.previous.filePath ||
      current.stateHash !== input.expectedWrittenStateHash
    ) {
      return yield* new CodexSkillOverrideTargetError({
        reason: "state-changed",
        message:
          "Codex project configuration changed after application; automatic rollback was not attempted",
      });
    }
    if (!input.previous.exists) {
      yield* fileSystem.remove(current.filePath, { force: true }).pipe(
        Effect.mapError(
          () =>
            new CodexSkillOverrideTargetError({
              reason: "persistence-failed",
              message: "New Codex project configuration could not be removed during rollback",
            }),
        ),
      );
      return;
    }
    yield* writeFileStringAtomically({
      filePath: input.previous.filePath,
      contents: input.previous.contents,
    }).pipe(
      Effect.mapError(
        () =>
          new CodexSkillOverrideTargetError({
            reason: "persistence-failed",
            message: "Codex project configuration could not be restored during rollback",
          }),
      ),
    );
  },
);
