import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type {
  EnvironmentBundleMcpServer,
  EnvironmentBundleProjectInstruction,
  EnvironmentBundleServerInventory,
  ServerSettings,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
// The package's default UMD entry uses runtime-relative `require("./impl/*")`
// calls. When inlined into the single server bundle those paths become relative
// to bin.mjs and disappear from the packaged desktop payload. The ESM entry has
// static imports, so the bundler can include the complete parser implementation.
import { parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";

import { expandHomePathWith } from "../pathExpansion.ts";
import {
  claudeDisabledMcpServerNames,
  loadClaudeSkillOverrideTargetState,
} from "./ClaudeSkillOverrideTarget.ts";

const MAX_PROJECT_INSTRUCTION_BYTES = FileSystem.Size(256_000);
const MAX_MCP_CONFIG_BYTES = FileSystem.Size(1_000_000);

class InvalidJsonMcpConfigError extends Data.TaggedError("InvalidJsonMcpConfigError")<{
  readonly cause: unknown;
}> {}

export interface CodexMcpInventorySource {
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly homePath?: string;
  readonly launchArgs?: string;
}

export interface ClaudeMcpInventorySource {
  readonly instanceId: string;
  readonly enabled: boolean;
}

export interface CursorMcpInventorySource {
  readonly instanceId: string;
  readonly enabled: boolean;
}

export interface OpenCodeMcpInventorySource {
  readonly instanceId: string;
  readonly enabled: boolean;
}

interface ParsedCodexMcpServer {
  readonly enabled?: boolean;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly blockedTools?: ReadonlyArray<string>;
  readonly credentialRefs?: EnvironmentBundleMcpServer["credentialRefs"];
}

function recordValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function codexMcpInventorySourcesFromSettings(
  settings: ServerSettings,
): ReadonlyArray<CodexMcpInventorySource> {
  const sources = Object.entries(settings.providerInstances)
    .filter(([, instance]) => instance.driver === "codex")
    .map(([instanceId, instance]) => {
      const configEnabled = recordValue(instance.config, "enabled");
      const homePath = recordValue(instance.config, "homePath");
      const launchArgs = recordValue(instance.config, "launchArgs");
      return {
        instanceId,
        enabled: instance.enabled !== false && configEnabled !== false,
        ...(typeof homePath === "string" && homePath.trim().length > 0
          ? { homePath: homePath.trim() }
          : {}),
        ...(typeof launchArgs === "string" && launchArgs.trim().length > 0
          ? { launchArgs: launchArgs.trim() }
          : {}),
      } satisfies CodexMcpInventorySource;
    });

  if (!("codex" in settings.providerInstances)) {
    const legacy = settings.providers.codex;
    sources.push({
      instanceId: "codex",
      enabled: legacy.enabled,
      ...(legacy.homePath.trim().length > 0 ? { homePath: legacy.homePath } : {}),
      ...(legacy.launchArgs.trim().length > 0 ? { launchArgs: legacy.launchArgs } : {}),
    });
  }
  return sources;
}

function codexMcpEnablementOverrides(launchArgs: string | undefined): ReadonlyMap<string, boolean> {
  const tokens = tokenizeCliArgs(launchArgs);
  const overrides = new Map<string, boolean>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    let value: string | undefined;
    if (token === "-c" || token === "--config") {
      value = tokens[index + 1];
      if (value !== undefined) index += 1;
    } else if (token.startsWith("-c=")) {
      value = token.slice(3);
    } else if (token.startsWith("--config=")) {
      value = token.slice(9);
    }
    if (value === undefined) continue;
    const match = /^mcp_servers\.([A-Za-z0-9_.-]{1,256})\.enabled=(true|false)$/u.exec(value);
    if (match) overrides.set(match[1]!, match[2] === "true");
  }
  return overrides;
}

export function claudeMcpInventorySourcesFromSettings(
  settings: ServerSettings,
): ReadonlyArray<ClaudeMcpInventorySource> {
  const sources = Object.entries(settings.providerInstances)
    .filter(([, instance]) => instance.driver === "claudeAgent")
    .map(([instanceId, instance]) => {
      const configEnabled = recordValue(instance.config, "enabled");
      return {
        instanceId,
        enabled: instance.enabled !== false && configEnabled !== false,
      } satisfies ClaudeMcpInventorySource;
    });

  if (!("claudeAgent" in settings.providerInstances)) {
    sources.push({ instanceId: "claudeAgent", enabled: settings.providers.claudeAgent.enabled });
  }
  return sources;
}

export function cursorMcpInventorySourcesFromSettings(
  settings: ServerSettings,
): ReadonlyArray<CursorMcpInventorySource> {
  const sources = Object.entries(settings.providerInstances)
    .filter(([, instance]) => instance.driver === "cursor")
    .map(([instanceId, instance]) => {
      const configEnabled = recordValue(instance.config, "enabled");
      return {
        instanceId,
        enabled: instance.enabled !== false && configEnabled !== false,
      } satisfies CursorMcpInventorySource;
    });

  if (!("cursor" in settings.providerInstances)) {
    sources.push({ instanceId: "cursor", enabled: settings.providers.cursor.enabled });
  }
  return sources;
}

export function openCodeMcpInventorySourcesFromSettings(
  settings: ServerSettings,
): ReadonlyArray<OpenCodeMcpInventorySource> {
  const sources = Object.entries(settings.providerInstances)
    .filter(([, instance]) => instance.driver === "opencode")
    .map(([instanceId, instance]) => {
      const configEnabled = recordValue(instance.config, "enabled");
      return {
        instanceId,
        enabled: instance.enabled !== false && configEnabled !== false,
      } satisfies OpenCodeMcpInventorySource;
    });

  if (!("opencode" in settings.providerInstances)) {
    sources.push({ instanceId: "opencode", enabled: settings.providers.opencode.enabled });
  }
  return sources;
}

/**
 * Root instruction files with stable, portable paths. Provider-specific
 * nested discovery remains deliberately partial until each adapter reports
 * the exact files it loaded for a session.
 */
export const ROOT_PROJECT_INSTRUCTION_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
] as const;

function isWithinRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const resolveProjectRoot = Effect.fn("resolveEnvironmentBundleProjectRoot")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const initial = yield* fileSystem
    .realPath(cwd)
    .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  let candidate = initial;

  while (true) {
    const gitMarkerExists = yield* fileSystem
      .exists(path.join(candidate, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (gitMarkerExists) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return initial;
    candidate = parent;
  }
});

function parseMcpServerSection(value: string): string | null {
  const section = value.trim();
  const bare = /^mcp_servers\.([a-zA-Z0-9_-]{1,256})$/.exec(section)?.[1];
  if (bare) return bare;
  const quoted = /^mcp_servers\.(?:"([^"\\]{1,256})"|'([^']{1,256})')$/.exec(section);
  const name = quoted?.[1]?.trim() || quoted?.[2]?.trim();
  return name && /^[a-zA-Z0-9_.-]{1,256}$/.test(name) ? name : null;
}

function parseMcpServerEnvironmentSection(value: string): string | null {
  const section = value.trim();
  const bare = /^mcp_servers\.([a-zA-Z0-9_-]{1,256})\.env$/.exec(section)?.[1];
  if (bare) return bare;
  const quoted = /^mcp_servers\.(?:"([^"\\]{1,256})"|'([^']{1,256})')\.env$/.exec(section);
  const name = quoted?.[1]?.trim() || quoted?.[2]?.trim();
  return name && /^[a-zA-Z0-9_.-]{1,256}$/.test(name) ? name : null;
}

function stripTomlComment(value: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (!escaped && (character === '"' || character === "'")) {
      quote = quote === character ? null : quote === null ? character : quote;
    }
    if (!escaped && quote === null && character === "#") return value.slice(0, index).trim();
    escaped = false;
  }
  return value.trim();
}

function parseTomlStringArray(value: string): ReadonlyArray<string> | undefined {
  const input = stripTomlComment(value);
  if (!input.startsWith("[") || !input.endsWith("]")) return undefined;
  const entries: Array<string> = [];
  let rest = input.slice(1, -1).trim();
  while (rest.length > 0) {
    const match = /^(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*(?:,\s*|$)/.exec(rest);
    if (!match) return undefined;
    let entry: string;
    if (match[1] !== undefined) {
      try {
        entry = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return undefined;
      }
    } else {
      entry = match[2]!;
    }
    const trimmed = entry.trim();
    if (!/^[a-zA-Z0-9_.-]{1,256}$/.test(trimmed)) return undefined;
    entries.push(trimmed);
    rest = rest.slice(match[0].length).trim();
  }
  return [...new Set(entries)].sort((left, right) => left.localeCompare(right));
}

export function parseSanitizedCodexMcpConfig(
  contents: string,
): ReadonlyMap<string, ParsedCodexMcpServer> {
  const servers = new Map<string, ParsedCodexMcpServer>();
  let currentServerId: string | null = null;
  let readingEnvironment = false;

  for (const line of contents.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
    if (section) {
      const environmentServerId = parseMcpServerEnvironmentSection(section[1]!);
      currentServerId = environmentServerId ?? parseMcpServerSection(section[1]!);
      readingEnvironment = environmentServerId !== null;
      if (currentServerId && !servers.has(currentServerId)) servers.set(currentServerId, {});
      continue;
    }
    if (!currentServerId) continue;
    if (readingEnvironment) {
      const credentialName = /^\s*([a-zA-Z_][a-zA-Z0-9_]{0,255})\s*=/.exec(line)?.[1];
      if (!credentialName) continue;
      const existing = servers.get(currentServerId) ?? {};
      const ids = new Set((existing.credentialRefs ?? []).map((reference) => reference.id));
      ids.add(credentialName);
      servers.set(currentServerId, {
        ...existing,
        credentialRefs: [...ids]
          .sort((left, right) => left.localeCompare(right))
          .map((id) => ({ kind: "environment-variable" as const, id })),
      });
      continue;
    }
    const field = /^\s*(enabled|enabled_tools|disabled_tools)\s*=\s*(.+?)\s*$/.exec(line);
    if (!field) continue;
    const existing = servers.get(currentServerId) ?? {};
    if (field[1] === "enabled") {
      const value = stripTomlComment(field[2]!);
      if (value === "true" || value === "false") {
        servers.set(currentServerId, { ...existing, enabled: value === "true" });
      }
      continue;
    }
    const tools = parseTomlStringArray(field[2]!);
    if (!tools) continue;
    servers.set(currentServerId, {
      ...existing,
      ...(field[1] === "enabled_tools" ? { allowedTools: tools } : { blockedTools: tools }),
    });
  }
  return servers;
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function addEnvironmentReferences(value: unknown, references: Set<string>): void {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(/\$\{([a-zA-Z_][a-zA-Z0-9_]{0,255})(?::-[^}]*)?}/g)) {
    references.add(match[1]!);
  }
}

function addOpenCodeEnvironmentReferences(value: unknown, references: Set<string>): void {
  if (typeof value === "string") {
    addEnvironmentReferences(value, references);
    for (const match of value.matchAll(/\{env:([a-zA-Z_][a-zA-Z0-9_]{0,255})}/g)) {
      references.add(match[1]!);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) addOpenCodeEnvironmentReferences(entry, references);
    return;
  }
  const record = jsonRecord(value);
  if (!record) return;
  for (const entry of Object.values(record)) addOpenCodeEnvironmentReferences(entry, references);
}

/**
 * Reads only identities and environment-variable reference names from the
 * common JSON MCP shape. Executables, arguments, URLs, headers, and values
 * are inspected in memory but never returned or hashed.
 */
export function parseSanitizedJsonMcpConfig(
  contents: string,
): ReadonlyMap<string, Pick<ParsedCodexMcpServer, "credentialRefs">> {
  const root = jsonRecord(JSON.parse(contents));
  const mcpServers = jsonRecord(root?.mcpServers);
  if (!mcpServers) return new Map();

  const servers = new Map<string, Pick<ParsedCodexMcpServer, "credentialRefs">>();
  for (const [name, unknownServer] of Object.entries(mcpServers).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!/^[a-zA-Z0-9_.-]{1,256}$/.test(name)) continue;
    const server = jsonRecord(unknownServer);
    if (!server) continue;
    const references = new Set<string>();
    const environment = jsonRecord(server.env);
    if (environment) {
      for (const key of Object.keys(environment)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]{0,255}$/.test(key)) references.add(key);
      }
    }
    addEnvironmentReferences(server.command, references);
    addEnvironmentReferences(server.url, references);
    if (Array.isArray(server.args)) {
      for (const argument of server.args) addEnvironmentReferences(argument, references);
    }
    const headers = jsonRecord(server.headers);
    if (headers) {
      for (const value of Object.values(headers)) addEnvironmentReferences(value, references);
    }
    servers.set(name, {
      credentialRefs: [...references]
        .sort((left, right) => left.localeCompare(right))
        .map((id) => ({ kind: "environment-variable" as const, id })),
    });
  }
  return servers;
}

/**
 * Parses only portable OpenCode MCP metadata from JSON/JSONC. Both the v1
 * `mcp.<name>` shape and the v2 `mcp.servers.<name>` shape are accepted.
 * File references and every executable/configuration value are discarded.
 */
export function parseSanitizedOpenCodeMcpConfig(
  contents: string,
): ReadonlyMap<string, ParsedCodexMcpServer> {
  const errors: ParseError[] = [];
  const root = jsonRecord(
    parseJsonc(contents, errors, { allowTrailingComma: true, disallowComments: false }),
  );
  if (errors.length > 0) return new Map();
  const mcp = jsonRecord(root?.mcp);
  const nestedServers = jsonRecord(mcp?.servers);
  const configuredServers = nestedServers ?? mcp;
  if (!configuredServers) return new Map();

  const servers = new Map<string, ParsedCodexMcpServer>();
  for (const [name, unknownServer] of Object.entries(configuredServers).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!/^[a-zA-Z0-9_.-]{1,256}$/.test(name)) continue;
    const server = jsonRecord(unknownServer);
    if (!server) continue;
    const references = new Set<string>();
    const environment = jsonRecord(server.environment);
    if (environment) {
      for (const key of Object.keys(environment)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]{0,255}$/.test(key)) references.add(key);
      }
    }
    for (const field of [
      server.command,
      server.url,
      server.headers,
      server.environment,
      server.oauth,
    ]) {
      addOpenCodeEnvironmentReferences(field, references);
    }
    servers.set(name, {
      enabled: server.disabled === true ? false : server.enabled !== false,
      credentialRefs: [...references]
        .sort((left, right) => left.localeCompare(right))
        .map((id) => ({ kind: "environment-variable" as const, id })),
    });
  }
  return servers;
}

const readCodexMcpConfig = Effect.fn("readEnvironmentBundleCodexMcpConfig")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath);
  if (info.type !== "File" || info.size > MAX_MCP_CONFIG_BYTES) return new Map();
  return parseSanitizedCodexMcpConfig(yield* fileSystem.readFileString(filePath));
});

const readJsonMcpConfig = Effect.fn("readEnvironmentBundleJsonMcpConfig")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath);
  if (info.type !== "File" || info.size > MAX_MCP_CONFIG_BYTES) return new Map();
  const contents = yield* fileSystem.readFileString(filePath);
  return yield* Effect.try({
    try: () => parseSanitizedJsonMcpConfig(contents),
    catch: (cause) => new InvalidJsonMcpConfigError({ cause }),
  });
});

const readOpenCodeMcpConfig = Effect.fn("readEnvironmentBundleOpenCodeMcpConfig")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath);
  if (info.type !== "File" || info.size > MAX_MCP_CONFIG_BYTES) return new Map();
  return parseSanitizedOpenCodeMcpConfig(yield* fileSystem.readFileString(filePath));
});

function mergeMcpConfigs(
  base: ReadonlyMap<string, ParsedCodexMcpServer>,
  override: ReadonlyMap<string, ParsedCodexMcpServer>,
): ReadonlyMap<string, ParsedCodexMcpServer> {
  const merged = new Map(base);
  for (const [serverId, entry] of override) {
    const previous = merged.get(serverId);
    const credentialRefs = new Map(
      [...(previous?.credentialRefs ?? []), ...(entry.credentialRefs ?? [])].map((reference) => [
        `${reference.kind}:${reference.id}`,
        reference,
      ]),
    );
    merged.set(serverId, {
      ...previous,
      ...entry,
      ...(credentialRefs.size > 0
        ? {
            credentialRefs: [...credentialRefs.values()].sort((left, right) =>
              left.id.localeCompare(right.id),
            ),
          }
        : {}),
    });
  }
  return merged;
}

function sanitizedConfigurationHash(server: EnvironmentBundleMcpServer): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        serverId: server.serverId,
        origin: server.origin,
        enabled: server.enabled,
        allowedTools: server.allowedTools,
        blockedTools: server.blockedTools,
        credentialRefs: server.credentialRefs,
      }),
    )
    .digest("hex");
}

function boundedMcpId(prefix: string, name: string): string {
  const candidate = `${prefix}:${name}`;
  if (candidate.length <= 256) return candidate;
  const suffix = NodeCrypto.createHash("sha256").update(name).digest("hex").slice(0, 32);
  return `${prefix}:sha256-${suffix}`;
}

const loadCodexMcpInventory = Effect.fn("loadEnvironmentBundleCodexMcpInventory")(function* (
  root: string,
  sources: ReadonlyArray<CodexMcpInventorySource>,
) {
  const path = yield* Path.Path;
  const projectConfig = yield* readCodexMcpConfig(path.join(root, ".codex", "config.toml")).pipe(
    Effect.orElseSucceed(() => new Map()),
  );
  return yield* Effect.forEach(
    sources,
    (source) =>
      Effect.gen(function* () {
        const homePath = path.resolve(
          expandHomePathWith(source.homePath ?? path.join(NodeOS.homedir(), ".codex"), path),
        );
        const userConfig = yield* readCodexMcpConfig(path.join(homePath, "config.toml")).pipe(
          Effect.orElseSucceed(() => new Map()),
        );
        const effectiveConfig = mergeMcpConfigs(userConfig, projectConfig);
        const enablementOverrides = codexMcpEnablementOverrides(source.launchArgs);
        return [...effectiveConfig.entries()].map(([name, config]) => {
          const blockedTools = [...(config.blockedTools ?? [])];
          const blockedToolSet = new Set(blockedTools);
          const server = {
            serverId: boundedMcpId(`codex:${source.instanceId}`, name),
            origin: `codex:${source.instanceId}:effective-config`,
            enabled: source.enabled && (enablementOverrides.get(name) ?? config.enabled !== false),
            configurationRef: boundedMcpId(`codex:${source.instanceId}:mcp`, name),
            credentialRefs: [...(config.credentialRefs ?? [])],
            // A contradictory native config must remain fail-closed in the
            // portable representation: block wins over allow.
            allowedTools: [...(config.allowedTools ?? [])].filter(
              (tool) => !blockedToolSet.has(tool),
            ),
            blockedTools,
          } satisfies EnvironmentBundleMcpServer;
          return { ...server, configurationHash: sanitizedConfigurationHash(server) };
        });
      }),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((groups) => groups.flat().sort((a, b) => a.serverId.localeCompare(b.serverId))),
  );
});

const loadProjectJsonMcpInventory = Effect.fn("loadEnvironmentBundleProjectJsonMcpInventory")(
  function* (
    root: string,
    sources: ReadonlyArray<ClaudeMcpInventorySource | CursorMcpInventorySource>,
    adapter: {
      readonly provider: "claude" | "cursor";
      readonly relativeConfigPath: ReadonlyArray<string>;
    },
  ) {
    const path = yield* Path.Path;
    const projectConfig = yield* readJsonMcpConfig(
      path.join(root, ...adapter.relativeConfigPath),
    ).pipe(Effect.orElseSucceed(() => new Map()));
    return sources.flatMap((source) =>
      [...projectConfig.entries()].map(([name, config]) => {
        const server = {
          serverId: boundedMcpId(`${adapter.provider}:${source.instanceId}`, name),
          origin: `${adapter.provider}:${source.instanceId}:project-config`,
          enabled: source.enabled,
          configurationRef: boundedMcpId(`${adapter.provider}:${source.instanceId}:mcp`, name),
          credentialRefs: [...(config.credentialRefs ?? [])],
          allowedTools: [],
          blockedTools: [],
        } satisfies EnvironmentBundleMcpServer;
        return { ...server, configurationHash: sanitizedConfigurationHash(server) };
      }),
    );
  },
);

const loadClaudeMcpInventory = Effect.fn("loadEnvironmentBundleClaudeMcpInventory")(function* (
  root: string,
  sources: ReadonlyArray<ClaudeMcpInventorySource>,
) {
  const disabledNames = yield* loadClaudeSkillOverrideTargetState(root).pipe(
    Effect.map(claudeDisabledMcpServerNames),
    Effect.orElseSucceed(() => new Set<string>()),
  );
  const inventory = yield* loadProjectJsonMcpInventory(root, sources, {
    provider: "claude",
    relativeConfigPath: [".mcp.json"],
  });
  return inventory.map((server) => {
    const source = sources.find(
      (candidate) => server.origin === `claude:${candidate.instanceId}:project-config`,
    );
    const prefix = source ? `claude:${source.instanceId}:` : "";
    const nativeName =
      prefix && server.serverId.startsWith(prefix) ? server.serverId.slice(prefix.length) : "";
    if (!nativeName || !disabledNames.has(nativeName)) return server;
    const disabled = { ...server, enabled: false };
    return { ...disabled, configurationHash: sanitizedConfigurationHash(disabled) };
  });
});

const loadCursorMcpInventory = Effect.fn("loadEnvironmentBundleCursorMcpInventory")(function* (
  root: string,
  sources: ReadonlyArray<CursorMcpInventorySource>,
) {
  return yield* loadProjectJsonMcpInventory(root, sources, {
    provider: "cursor",
    relativeConfigPath: [".cursor", "mcp.json"],
  });
});

const loadOpenCodeMcpInventory = Effect.fn("loadEnvironmentBundleOpenCodeMcpInventory")(function* (
  root: string,
  sources: ReadonlyArray<OpenCodeMcpInventorySource>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const jsoncPath = path.join(root, "opencode.jsonc");
  const jsonPath = path.join(root, "opencode.json");
  const selectedPath = (yield* fileSystem.exists(jsoncPath).pipe(Effect.orElseSucceed(() => false)))
    ? jsoncPath
    : jsonPath;
  const projectConfig = yield* readOpenCodeMcpConfig(selectedPath).pipe(
    Effect.orElseSucceed(() => new Map()),
  );
  return sources.flatMap((source) =>
    [...projectConfig.entries()].map(([name, config]) => {
      const server = {
        serverId: boundedMcpId(`opencode:${source.instanceId}`, name),
        origin: `opencode:${source.instanceId}:project-config`,
        enabled: source.enabled && config.enabled !== false,
        configurationRef: boundedMcpId(`opencode:${source.instanceId}:mcp`, name),
        credentialRefs: [...(config.credentialRefs ?? [])],
        allowedTools: [],
        blockedTools: [],
      } satisfies EnvironmentBundleMcpServer;
      return { ...server, configurationHash: sanitizedConfigurationHash(server) };
    }),
  );
});

const readProjectInstruction = Effect.fn("readEnvironmentBundleProjectInstruction")(function* (
  root: string,
  logicalPath: (typeof ROOT_PROJECT_INSTRUCTION_PATHS)[number],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidate = yield* fileSystem.realPath(path.join(root, logicalPath));
  if (!isWithinRoot(path, root, candidate)) return null;
  const info = yield* fileSystem.stat(candidate);
  if (info.type !== "File" || info.size > MAX_PROJECT_INSTRUCTION_BYTES) return null;
  const contents = yield* fileSystem.readFile(candidate);
  return {
    logicalPath,
    contentHash: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
    enabled: true,
  } satisfies EnvironmentBundleProjectInstruction;
});

export const loadEnvironmentBundleServerInventory = Effect.fn(
  "loadEnvironmentBundleServerInventory",
)(function* (input: {
  readonly cwd: string;
  readonly codexMcpSources?: ReadonlyArray<CodexMcpInventorySource>;
  readonly claudeMcpSources?: ReadonlyArray<ClaudeMcpInventorySource>;
  readonly cursorMcpSources?: ReadonlyArray<CursorMcpInventorySource>;
  readonly openCodeMcpSources?: ReadonlyArray<OpenCodeMcpInventorySource>;
}): Effect.fn.Return<EnvironmentBundleServerInventory, never, FileSystem.FileSystem | Path.Path> {
  const root = yield* resolveProjectRoot(input.cwd);
  const projectInstructions = yield* Effect.forEach(
    ROOT_PROJECT_INSTRUCTION_PATHS,
    (logicalPath) =>
      readProjectInstruction(root, logicalPath).pipe(Effect.orElseSucceed(() => null)),
    { concurrency: "unbounded" },
  );
  const availableProjectInstructions = projectInstructions.filter((entry) => entry !== null);
  const mcpServers = [
    ...(yield* loadCodexMcpInventory(root, input.codexMcpSources ?? [])),
    ...(yield* loadClaudeMcpInventory(root, input.claudeMcpSources ?? [])),
    ...(yield* loadCursorMcpInventory(root, input.cursorMcpSources ?? [])),
    ...(yield* loadOpenCodeMcpInventory(root, input.openCodeMcpSources ?? [])),
  ].sort((left, right) => left.serverId.localeCompare(right.serverId));

  return {
    mcpServers,
    // Only adapter-declared safe fields are inventoried. Commands, URLs,
    // environment values, and provider-native secrets are never copied.
    mcpCoverage:
      input.codexMcpSources?.length ||
      input.claudeMcpSources?.length ||
      input.cursorMcpSources?.length ||
      input.openCodeMcpSources?.length
        ? "partial"
        : "unavailable",
    projectInstructions: availableProjectInstructions,
    projectInstructionsCoverage: "partial",
  };
});
