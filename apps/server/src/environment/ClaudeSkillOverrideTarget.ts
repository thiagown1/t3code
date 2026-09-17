import * as NodeCrypto from "node:crypto";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
} from "jsonc-parser/lib/esm/main.js";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { findEnvironmentBundleRepositoryRoot } from "./EnvironmentBundlePaths.ts";

const MAX_CLAUDE_SETTINGS_BYTES = FileSystem.Size(1_000_000);
const MISSING_TARGET_MARKER = "t3-environment-bundle:missing";

class ClaudeSkillOverrideTargetError extends Data.TaggedError("ClaudeSkillOverrideTargetError")<{
  readonly reason: "invalid-json" | "too-large" | "state-changed" | "persistence-failed";
  readonly message: string;
}> {}

export interface ClaudeSkillOverrideTargetState {
  readonly filePath: string;
  readonly exists: boolean;
  readonly contents: string;
  readonly stateHash: string;
}

function stateHash(exists: boolean, contents: string): string {
  return NodeCrypto.createHash("sha256")
    .update(exists ? `present\0${contents}` : MISSING_TARGET_MARKER)
    .digest("hex");
}

function validateJsonc(contents: string): void {
  if (contents.trim().length === 0) return;
  const errors: ParseError[] = [];
  const parsed = parseJsonc(contents, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (
    errors.length > 0 ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (Object.hasOwn(parsed, "skillOverrides") &&
      (parsed.skillOverrides === null ||
        typeof parsed.skillOverrides !== "object" ||
        Array.isArray(parsed.skillOverrides))) ||
    (Object.hasOwn(parsed, "disabledMcpjsonServers") &&
      (!Array.isArray(parsed.disabledMcpjsonServers) ||
        parsed.disabledMcpjsonServers.some(
          (name: unknown) => typeof name !== "string" || !/^[a-zA-Z0-9_.-]{1,256}$/u.test(name),
        )))
  ) {
    throw new ClaudeSkillOverrideTargetError({
      reason: "invalid-json",
      message:
        "Claude project settings are not a valid JSON object with supported skill and MCP overrides",
    });
  }
}

export const loadClaudeSkillOverrideTargetState = Effect.fn("loadClaudeSkillOverrideTargetState")(
  function* (cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* findEnvironmentBundleRepositoryRoot(cwd);
    const filePath = path.join(root, ".claude", "settings.local.json");
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { filePath, exists: false, contents: "", stateHash: stateHash(false, "") };
    }
    const info = yield* fileSystem.stat(filePath).pipe(
      Effect.mapError(
        () =>
          new ClaudeSkillOverrideTargetError({
            reason: "persistence-failed",
            message: "Claude project settings could not be inspected",
          }),
      ),
    );
    if (info.type !== "File" || info.size > MAX_CLAUDE_SETTINGS_BYTES) {
      return yield* new ClaudeSkillOverrideTargetError({
        reason: "too-large",
        message: "Claude project settings are not a regular file within the 1 MB safety limit",
      });
    }
    const contents = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        () =>
          new ClaudeSkillOverrideTargetError({
            reason: "persistence-failed",
            message: "Claude project settings could not be read",
          }),
      ),
    );
    yield* Effect.try({
      try: () => validateJsonc(contents),
      catch: (cause) =>
        cause instanceof ClaudeSkillOverrideTargetError
          ? cause
          : new ClaudeSkillOverrideTargetError({
              reason: "invalid-json",
              message: "Claude project settings could not be parsed",
            }),
    });
    return { filePath, exists: true, contents, stateHash: stateHash(true, contents) };
  },
);

function renderClaudeSkillDisableOverrides(
  state: ClaudeSkillOverrideTargetState,
  skillNames: ReadonlyArray<string>,
  mcpServerNames: ReadonlyArray<string> = [],
): string {
  const eol = state.contents.includes("\r\n") ? "\r\n" : "\n";
  let contents = state.contents.trim().length === 0 ? `{${eol}}${eol}` : state.contents;
  for (const skillName of [...new Set(skillNames)].sort()) {
    contents = applyEdits(
      contents,
      modify(contents, ["skillOverrides", skillName], "off", {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol },
      }),
    );
  }
  if (mcpServerNames.length > 0) {
    const parsed = parseJsonc(contents) as { disabledMcpjsonServers?: ReadonlyArray<string> };
    const disabledMcpjsonServers = [
      ...new Set([...(parsed.disabledMcpjsonServers ?? []), ...mcpServerNames]),
    ].sort();
    contents = applyEdits(
      contents,
      modify(contents, ["disabledMcpjsonServers"], disabledMcpjsonServers, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol },
      }),
    );
  }
  return contents.endsWith(eol) ? contents : `${contents}${eol}`;
}

export function claudeDisabledMcpServerNames(
  state: ClaudeSkillOverrideTargetState,
): ReadonlySet<string> {
  if (state.contents.trim().length === 0) return new Set();
  const parsed = parseJsonc(state.contents) as { disabledMcpjsonServers?: ReadonlyArray<string> };
  return new Set(parsed.disabledMcpjsonServers ?? []);
}

export const writeClaudeSkillDisableOverrides = Effect.fn("writeClaudeSkillDisableOverrides")(
  function* (input: {
    readonly cwd: string;
    readonly expectedStateHash: string;
    readonly skillNames: ReadonlyArray<string>;
    readonly mcpServerNames?: ReadonlyArray<string>;
  }) {
    const current = yield* loadClaudeSkillOverrideTargetState(input.cwd);
    if (current.stateHash !== input.expectedStateHash) {
      return yield* new ClaudeSkillOverrideTargetError({
        reason: "state-changed",
        message: "Claude project settings changed after the Environment Bundle dry run",
      });
    }
    const contents = renderClaudeSkillDisableOverrides(
      current,
      input.skillNames,
      input.mcpServerNames,
    );
    yield* writeFileStringAtomically({ filePath: current.filePath, contents }).pipe(
      Effect.mapError(
        () =>
          new ClaudeSkillOverrideTargetError({
            reason: "persistence-failed",
            message: "Claude project settings could not be written atomically",
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
      } satisfies ClaudeSkillOverrideTargetState,
    };
  },
);

export const rollbackClaudeSkillDisableOverrides = Effect.fn("rollbackClaudeSkillDisableOverrides")(
  function* (input: {
    readonly cwd: string;
    readonly expectedWrittenStateHash: string;
    readonly previous: ClaudeSkillOverrideTargetState;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const current = yield* loadClaudeSkillOverrideTargetState(input.cwd);
    if (
      current.filePath !== input.previous.filePath ||
      current.stateHash !== input.expectedWrittenStateHash
    ) {
      return yield* new ClaudeSkillOverrideTargetError({
        reason: "state-changed",
        message:
          "Claude project settings changed after application; automatic rollback was not attempted",
      });
    }
    if (!input.previous.exists) {
      yield* fileSystem.remove(current.filePath, { force: true }).pipe(
        Effect.mapError(
          () =>
            new ClaudeSkillOverrideTargetError({
              reason: "persistence-failed",
              message: "New Claude project settings could not be removed during rollback",
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
          new ClaudeSkillOverrideTargetError({
            reason: "persistence-failed",
            message: "Claude project settings could not be restored during rollback",
          }),
      ),
    );
  },
);
