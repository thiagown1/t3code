import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type {
  EnvironmentBundleMcpServer,
  EnvironmentBundleProjectInstruction,
  EnvironmentBundleServerInventory,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePathWith } from "../pathExpansion.ts";

const MAX_PROJECT_INSTRUCTION_BYTES = FileSystem.Size(256_000);
const MAX_MCP_CONFIG_BYTES = FileSystem.Size(1_000_000);

export interface CodexMcpInventorySource {
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly homePath?: string;
}

interface ParsedCodexMcpServer {
  readonly enabled?: boolean;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly blockedTools?: ReadonlyArray<string>;
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
      return {
        instanceId,
        enabled: instance.enabled !== false && configEnabled !== false,
        ...(typeof homePath === "string" && homePath.trim().length > 0
          ? { homePath: homePath.trim() }
          : {}),
      } satisfies CodexMcpInventorySource;
    });

  if (!("codex" in settings.providerInstances)) {
    const legacy = settings.providers.codex;
    sources.push({
      instanceId: "codex",
      enabled: legacy.enabled,
      ...(legacy.homePath.trim().length > 0 ? { homePath: legacy.homePath } : {}),
    });
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

  for (const line of contents.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
    if (section) {
      currentServerId = parseMcpServerSection(section[1]!);
      if (currentServerId && !servers.has(currentServerId)) servers.set(currentServerId, {});
      continue;
    }
    if (!currentServerId) continue;
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

const readCodexMcpConfig = Effect.fn("readEnvironmentBundleCodexMcpConfig")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath);
  if (info.type !== "File" || info.size > MAX_MCP_CONFIG_BYTES) return new Map();
  return parseSanitizedCodexMcpConfig(yield* fileSystem.readFileString(filePath));
});

function mergeMcpConfigs(
  base: ReadonlyMap<string, ParsedCodexMcpServer>,
  override: ReadonlyMap<string, ParsedCodexMcpServer>,
): ReadonlyMap<string, ParsedCodexMcpServer> {
  const merged = new Map(base);
  for (const [serverId, entry] of override) {
    merged.set(serverId, { ...merged.get(serverId), ...entry });
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
        return [...effectiveConfig.entries()].map(([name, config]) => {
          const blockedTools = [...(config.blockedTools ?? [])];
          const blockedToolSet = new Set(blockedTools);
          const server = {
            serverId: boundedMcpId(`codex:${source.instanceId}`, name),
            origin: `codex:${source.instanceId}:effective-config`,
            enabled: source.enabled && config.enabled !== false,
            configurationRef: boundedMcpId(`codex:${source.instanceId}:mcp`, name),
            credentialRefs: [],
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
}): Effect.fn.Return<EnvironmentBundleServerInventory, never, FileSystem.FileSystem | Path.Path> {
  const root = yield* resolveProjectRoot(input.cwd);
  const projectInstructions = yield* Effect.forEach(
    ROOT_PROJECT_INSTRUCTION_PATHS,
    (logicalPath) =>
      readProjectInstruction(root, logicalPath).pipe(Effect.orElseSucceed(() => null)),
    { concurrency: "unbounded" },
  );
  const availableProjectInstructions = projectInstructions.filter((entry) => entry !== null);
  const mcpServers = yield* loadCodexMcpInventory(root, input.codexMcpSources ?? []);

  return {
    mcpServers,
    // Only Codex's known, safe fields are currently inventoried. Commands,
    // URLs, environment values, and provider-native secrets are never copied.
    mcpCoverage: input.codexMcpSources?.length ? "partial" : "unavailable",
    projectInstructions: availableProjectInstructions,
    projectInstructionsCoverage: "partial",
  };
});
