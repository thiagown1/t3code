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

const MAX_OPENCODE_CONFIG_BYTES = FileSystem.Size(1_000_000);
const SAFE_SERVER_NAME = /^[a-zA-Z0-9_.-]{1,256}$/u;

class OpenCodeMcpOverrideTargetError extends Data.TaggedError("OpenCodeMcpOverrideTargetError")<{
  readonly reason:
    | "invalid-json"
    | "not-found"
    | "too-large"
    | "state-changed"
    | "persistence-failed";
  readonly message: string;
}> {}

export interface OpenCodeMcpOverrideTargetState {
  readonly filePath: string;
  readonly contents: string;
  readonly stateHash: string;
  readonly serverPaths: ReadonlyMap<string, ReadonlyArray<string>>;
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stateHash(filePath: string, contents: string): string {
  return NodeCrypto.createHash("sha256")
    .update(`present\0${filePath.replaceAll("\\", "/").split("/").at(-1)}\0${contents}`)
    .digest("hex");
}

function parseServerPaths(contents: string): ReadonlyMap<string, ReadonlyArray<string>> {
  const errors: ParseError[] = [];
  const root = jsonRecord(
    parseJsonc(contents, errors, { allowTrailingComma: true, disallowComments: false }),
  );
  const mcp = jsonRecord(root?.mcp);
  if (errors.length > 0 || !root || !mcp) {
    throw new OpenCodeMcpOverrideTargetError({
      reason: "invalid-json",
      message: "OpenCode project configuration is not valid JSONC with an MCP object",
    });
  }
  const nestedServers = jsonRecord(mcp.servers);
  const configuredServers = nestedServers ?? mcp;
  const prefix = nestedServers ? ["mcp", "servers"] : ["mcp"];
  const paths = new Map<string, ReadonlyArray<string>>();
  for (const [name, unknownServer] of Object.entries(configuredServers)) {
    if (!SAFE_SERVER_NAME.test(name)) continue;
    const server = jsonRecord(unknownServer);
    if (!server) continue;
    if (
      (Object.hasOwn(server, "disabled") && typeof server.disabled !== "boolean") ||
      (Object.hasOwn(server, "enabled") && typeof server.enabled !== "boolean")
    ) {
      throw new OpenCodeMcpOverrideTargetError({
        reason: "invalid-json",
        message: `OpenCode MCP ${name} has an invalid enablement field`,
      });
    }
    paths.set(name, [...prefix, name]);
  }
  return paths;
}

export const loadOpenCodeMcpOverrideTargetState = Effect.fn("loadOpenCodeMcpOverrideTargetState")(
  function* (cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* findEnvironmentBundleRepositoryRoot(cwd);
    const jsoncPath = path.join(root, "opencode.jsonc");
    const jsonPath = path.join(root, "opencode.json");
    const filePath = (yield* fileSystem.exists(jsoncPath).pipe(Effect.orElseSucceed(() => false)))
      ? jsoncPath
      : jsonPath;
    if (!(yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new OpenCodeMcpOverrideTargetError({
        reason: "not-found",
        message: "OpenCode project configuration was not found",
      });
    }
    const info = yield* fileSystem.stat(filePath).pipe(
      Effect.mapError(
        () =>
          new OpenCodeMcpOverrideTargetError({
            reason: "persistence-failed",
            message: "OpenCode project configuration could not be inspected",
          }),
      ),
    );
    if (info.type !== "File" || info.size > MAX_OPENCODE_CONFIG_BYTES) {
      return yield* new OpenCodeMcpOverrideTargetError({
        reason: "too-large",
        message:
          "OpenCode project configuration is not a regular file within the 1 MB safety limit",
      });
    }
    const contents = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        () =>
          new OpenCodeMcpOverrideTargetError({
            reason: "persistence-failed",
            message: "OpenCode project configuration could not be read",
          }),
      ),
    );
    const serverPaths = yield* Effect.try({
      try: () => parseServerPaths(contents),
      catch: (cause) =>
        cause instanceof OpenCodeMcpOverrideTargetError
          ? cause
          : new OpenCodeMcpOverrideTargetError({
              reason: "invalid-json",
              message: "OpenCode project configuration could not be parsed",
            }),
    });
    return { filePath, contents, serverPaths, stateHash: stateHash(filePath, contents) };
  },
);

function renderOpenCodeMcpDisableOverrides(
  state: OpenCodeMcpOverrideTargetState,
  serverNames: ReadonlyArray<string>,
): string {
  const eol = state.contents.includes("\r\n") ? "\r\n" : "\n";
  let contents = state.contents;
  for (const serverName of [...new Set(serverNames)].sort()) {
    const serverPath = state.serverPaths.get(serverName);
    if (!serverPath) {
      throw new OpenCodeMcpOverrideTargetError({
        reason: "not-found",
        message: `OpenCode MCP ${serverName} was not found in the project configuration`,
      });
    }
    contents = applyEdits(
      contents,
      modify(contents, [...serverPath, "disabled"], true, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol },
      }),
    );
  }
  return contents.endsWith(eol) ? contents : `${contents}${eol}`;
}

export const writeOpenCodeMcpDisableOverrides = Effect.fn("writeOpenCodeMcpDisableOverrides")(
  function* (input: {
    readonly cwd: string;
    readonly expectedStateHash: string;
    readonly serverNames: ReadonlyArray<string>;
  }) {
    const current = yield* loadOpenCodeMcpOverrideTargetState(input.cwd);
    if (current.stateHash !== input.expectedStateHash) {
      return yield* new OpenCodeMcpOverrideTargetError({
        reason: "state-changed",
        message: "OpenCode project configuration changed after the Environment Bundle dry run",
      });
    }
    const contents = yield* Effect.try({
      try: () => renderOpenCodeMcpDisableOverrides(current, input.serverNames),
      catch: (cause) =>
        cause instanceof OpenCodeMcpOverrideTargetError
          ? cause
          : new OpenCodeMcpOverrideTargetError({
              reason: "persistence-failed",
              message: "OpenCode MCP disable overrides could not be rendered",
            }),
    });
    yield* writeFileStringAtomically({ filePath: current.filePath, contents }).pipe(
      Effect.mapError(
        () =>
          new OpenCodeMcpOverrideTargetError({
            reason: "persistence-failed",
            message: "OpenCode project configuration could not be written atomically",
          }),
      ),
    );
    return {
      previous: current,
      written: {
        ...current,
        contents,
        stateHash: stateHash(current.filePath, contents),
        serverPaths: parseServerPaths(contents),
      } satisfies OpenCodeMcpOverrideTargetState,
    };
  },
);

export const rollbackOpenCodeMcpDisableOverrides = Effect.fn("rollbackOpenCodeMcpDisableOverrides")(
  function* (input: {
    readonly cwd: string;
    readonly expectedWrittenStateHash: string;
    readonly previous: OpenCodeMcpOverrideTargetState;
  }) {
    const current = yield* loadOpenCodeMcpOverrideTargetState(input.cwd);
    if (
      current.filePath !== input.previous.filePath ||
      current.stateHash !== input.expectedWrittenStateHash
    ) {
      return yield* new OpenCodeMcpOverrideTargetError({
        reason: "state-changed",
        message:
          "OpenCode project configuration changed after application; automatic rollback was not attempted",
      });
    }
    yield* writeFileStringAtomically({
      filePath: input.previous.filePath,
      contents: input.previous.contents,
    }).pipe(
      Effect.mapError(
        () =>
          new OpenCodeMcpOverrideTargetError({
            reason: "persistence-failed",
            message: "OpenCode project configuration could not be restored during rollback",
          }),
      ),
    );
  },
);
