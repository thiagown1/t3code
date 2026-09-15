import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  claudeMcpInventorySourcesFromSettings,
  cursorMcpInventorySourcesFromSettings,
  loadEnvironmentBundleServerInventory,
  openCodeMcpInventorySourcesFromSettings,
  parseSanitizedJsonMcpConfig,
  parseSanitizedCodexMcpConfig,
  parseSanitizedOpenCodeMcpConfig,
} from "./EnvironmentBundleInventory.ts";

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("EnvironmentBundleInventory", () => {
  it.effect("hashes supported project instructions without exposing their contents", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-bundle-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".github"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "AGENTS.md"), "Agent policy\n");
      yield* fileSystem.writeFileString(
        path.join(cwd, ".github", "copilot-instructions.md"),
        "Copilot policy\n",
      );

      const inventory = yield* loadEnvironmentBundleServerInventory({ cwd });

      expect(inventory).toEqual({
        mcpServers: [],
        mcpCoverage: "unavailable",
        projectInstructions: [
          { logicalPath: "AGENTS.md", contentHash: sha256("Agent policy\n"), enabled: true },
          {
            logicalPath: ".github/copilot-instructions.md",
            contentHash: sha256("Copilot policy\n"),
            enabled: true,
          },
        ],
        projectInstructionsCoverage: "partial",
      });
      expect("content" in inventory.projectInstructions[0]!).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores oversized and nested files outside the declared partial inventory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-bundle-" });
      yield* fileSystem.makeDirectory(path.join(cwd, "nested"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "CLAUDE.md"), "x".repeat(256_001));
      yield* fileSystem.writeFileString(path.join(cwd, "nested", "AGENTS.md"), "nested");

      const inventory = yield* loadEnvironmentBundleServerInventory({ cwd });

      expect(inventory.projectInstructions).toEqual([]);
      expect(inventory.projectInstructionsCoverage).toBe("partial");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("finds root instructions when the server starts inside a git worktree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-bundle-" });
      const cwd = path.join(root, "apps", "server");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, ".git"), "gitdir: elsewhere\n");
      yield* fileSystem.writeFileString(path.join(root, "AGENTS.md"), "Root policy\n");

      const inventory = yield* loadEnvironmentBundleServerInventory({ cwd });

      expect(inventory.projectInstructions).toEqual([
        { logicalPath: "AGENTS.md", contentHash: sha256("Root policy\n"), enabled: true },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("extracts only safe MCP fields from Codex TOML", () => {
    const parsed = parseSanitizedCodexMcpConfig(`
[mcp_servers.firebase]
command = "npx"
args = ["secret-package", "--token", "do-not-export"]
enabled = false
enabled_tools = ["delete", "query", "read"]
disabled_tools = ["delete"] # keep writes blocked

[mcp_servers.firebase.env]
API_TOKEN = "do-not-export"
FIREBASE_PROFILE = "also-do-not-export"

[mcp_servers."logs.remote"]
url = "https://example.invalid?token=do-not-export"

[mcp_servers."C:/Users/private"]
command = "do-not-export"
`);

    expect([...parsed.entries()]).toEqual([
      [
        "firebase",
        {
          enabled: false,
          allowedTools: ["delete", "query", "read"],
          blockedTools: ["delete"],
          credentialRefs: [
            { kind: "environment-variable", id: "API_TOKEN" },
            { kind: "environment-variable", id: "FIREBASE_PROFILE" },
          ],
        },
      ],
      ["logs.remote", {}],
    ]);
    expect(Object.keys(parsed.get("firebase")!)).toEqual([
      "enabled",
      "allowedTools",
      "blockedTools",
      "credentialRefs",
    ]);
    expect(Object.keys(parsed.get("logs.remote")!)).toEqual([]);
  });

  it.effect("merges user and project Codex MCP metadata without exporting secrets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-bundle-" });
      const homePath = path.join(root, "codex-home");
      yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(root, ".codex"), { recursive: true });
      yield* fileSystem.makeDirectory(homePath, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(homePath, "config.toml"),
        '[mcp_servers.firebase]\ncommand = "secret-command"\nenabled = true\nenabled_tools = ["query", "write"]\ndisabled_tools = ["write"]\n[mcp_servers.firebase.env]\nFIREBASE_TOKEN = "secret-token"\n',
      );
      yield* fileSystem.writeFileString(
        path.join(root, ".codex", "config.toml"),
        '[mcp_servers.firebase]\nenabled = false\n[mcp_servers.logs]\nurl = "secret-url"\n',
      );

      const inventory = yield* loadEnvironmentBundleServerInventory({
        cwd: root,
        codexMcpSources: [{ instanceId: "codex-work", enabled: true, homePath }],
      });

      expect(inventory.mcpCoverage).toBe("partial");
      expect(inventory.mcpServers).toEqual([
        expect.objectContaining({
          serverId: "codex:codex-work:firebase",
          origin: "codex:codex-work:effective-config",
          enabled: false,
          configurationRef: "codex:codex-work:mcp:firebase",
          credentialRefs: [{ kind: "environment-variable", id: "FIREBASE_TOKEN" }],
          allowedTools: ["query"],
          blockedTools: ["write"],
          configurationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          serverId: "codex:codex-work:logs",
          enabled: true,
          allowedTools: [],
          blockedTools: [],
        }),
      ]);
      for (const server of inventory.mcpServers) {
        const exportedValues = Object.values(server).flat().join(" ");
        expect(exportedValues).not.toContain("secret-command");
        expect(exportedValues).not.toContain("secret-url");
        expect(exportedValues).not.toContain("secret-token");
        expect(exportedValues).not.toContain(homePath);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("discovers Claude instances without exposing provider configuration", () => {
    const settings = {
      providerInstances: {
        work: {
          driver: "claudeAgent",
          enabled: true,
          config: { enabled: false, homePath: "C:/private/claude", apiKey: "never-export" },
        },
      },
      providers: { claudeAgent: { enabled: true } },
    } as never;

    expect(claudeMcpInventorySourcesFromSettings(settings)).toEqual([
      { instanceId: "work", enabled: false },
      { instanceId: "claudeAgent", enabled: true },
    ]);
  });

  it("extracts only credential references from JSON MCP configuration", () => {
    const parsed = parseSanitizedJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          firebase: {
            command: "C:/private/bin/server.exe",
            args: ["--token", "do-not-export", "${FIREBASE_PROJECT:-demo}"],
            env: { FIREBASE_TOKEN: "do-not-export" },
            headers: { Authorization: "Bearer ${FIREBASE_API_KEY}" },
          },
          "logs.remote": { url: "https://example.invalid/${LOG_TENANT}/mcp?token=secret" },
          "C:/private": { command: "do-not-export" },
        },
      }),
    );

    expect([...parsed.entries()]).toEqual([
      [
        "firebase",
        {
          credentialRefs: [
            { kind: "environment-variable", id: "FIREBASE_API_KEY" },
            { kind: "environment-variable", id: "FIREBASE_PROJECT" },
            { kind: "environment-variable", id: "FIREBASE_TOKEN" },
          ],
        },
      ],
      ["logs.remote", { credentialRefs: [{ kind: "environment-variable", id: "LOG_TENANT" }] }],
    ]);
  });

  it.effect("inventories Claude project MCPs without exporting executable configuration", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-bundle-" });
      yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(root, ".mcp.json"),
        encodeUnknownJson({
          mcpServers: {
            firebase: {
              command: "C:/private/bin/server.exe",
              args: ["--token", "do-not-export"],
              env: { FIREBASE_TOKEN: "secret-token" },
            },
          },
        }),
      );

      const inventory = yield* loadEnvironmentBundleServerInventory({
        cwd: root,
        claudeMcpSources: [{ instanceId: "claude-work", enabled: true }],
      });

      expect(inventory.mcpCoverage).toBe("partial");
      expect(inventory.mcpServers).toEqual([
        expect.objectContaining({
          serverId: "claude:claude-work:firebase",
          origin: "claude:claude-work:project-config",
          enabled: true,
          configurationRef: "claude:claude-work:mcp:firebase",
          credentialRefs: [{ kind: "environment-variable", id: "FIREBASE_TOKEN" }],
          allowedTools: [],
          blockedTools: [],
          configurationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
      expect(encodeUnknownJson(inventory)).not.toContain("private/bin");
      expect(encodeUnknownJson(inventory)).not.toContain("secret-token");
      expect(encodeUnknownJson(inventory)).not.toContain("do-not-export");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("discovers Cursor instances without exposing provider configuration", () => {
    const settings = {
      providerInstances: {
        cursor_work: {
          driver: "cursor",
          enabled: true,
          config: { enabled: true, apiEndpoint: "https://private.invalid" },
        },
      },
      providers: { cursor: { enabled: false } },
    } as never;

    expect(cursorMcpInventorySourcesFromSettings(settings)).toEqual([
      { instanceId: "cursor_work", enabled: true },
      { instanceId: "cursor", enabled: false },
    ]);
  });

  it.effect("inventories Cursor project MCPs through the shared safe JSON parser", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-bundle-" });
      yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(root, ".cursor"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(root, ".cursor", "mcp.json"),
        encodeUnknownJson({
          mcpServers: {
            logs: {
              url: "https://${LOG_HOST}/mcp?token=do-not-export",
              headers: { Authorization: "Bearer ${LOG_TOKEN}" },
            },
          },
        }),
      );

      const inventory = yield* loadEnvironmentBundleServerInventory({
        cwd: root,
        cursorMcpSources: [{ instanceId: "cursor-work", enabled: false }],
      });

      expect(inventory.mcpServers).toEqual([
        expect.objectContaining({
          serverId: "cursor:cursor-work:logs",
          origin: "cursor:cursor-work:project-config",
          enabled: false,
          configurationRef: "cursor:cursor-work:mcp:logs",
          credentialRefs: [
            { kind: "environment-variable", id: "LOG_HOST" },
            { kind: "environment-variable", id: "LOG_TOKEN" },
          ],
        }),
      ]);
      expect(encodeUnknownJson(inventory)).not.toContain("private.invalid");
      expect(encodeUnknownJson(inventory)).not.toContain("do-not-export");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("discovers OpenCode instances without exposing provider configuration", () => {
    const settings = {
      providerInstances: {
        opencode_work: {
          driver: "opencode",
          enabled: true,
          config: { enabled: false, serverUrl: "https://private.invalid" },
        },
      },
      providers: { opencode: { enabled: true } },
    } as never;

    expect(openCodeMcpInventorySourcesFromSettings(settings)).toEqual([
      { instanceId: "opencode_work", enabled: false },
      { instanceId: "opencode", enabled: true },
    ]);
  });

  it("extracts safe OpenCode MCP state and environment references from JSONC", () => {
    const parsed = parseSanitizedOpenCodeMcpConfig(`{
      // Project-local OpenCode MCP configuration.
      "mcp": {
        "firebase": {
          "type": "local",
          "command": ["private-command", "{env:FIREBASE_PROJECT}"],
          "environment": { "FIREBASE_TOKEN": "do-not-export" },
          "enabled": false,
        },
        "logs.remote": {
          "type": "remote",
          "url": "https://example.invalid/{env:LOG_TENANT}",
          "headers": { "Authorization": "Bearer {env:LOG_TOKEN}" },
        },
      },
    }`);

    expect([...parsed.entries()]).toEqual([
      [
        "firebase",
        {
          enabled: false,
          credentialRefs: [
            { kind: "environment-variable", id: "FIREBASE_PROJECT" },
            { kind: "environment-variable", id: "FIREBASE_TOKEN" },
          ],
        },
      ],
      [
        "logs.remote",
        {
          enabled: true,
          credentialRefs: [
            { kind: "environment-variable", id: "LOG_TENANT" },
            { kind: "environment-variable", id: "LOG_TOKEN" },
          ],
        },
      ],
    ]);
    expect(encodeUnknownJson([...parsed.entries()])).not.toContain("private-command");
    expect(encodeUnknownJson([...parsed.entries()])).not.toContain("do-not-export");
  });

  it.effect("inventories nested OpenCode v2 project MCPs without exporting secrets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-bundle-" });
      yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(root, "opencode.json"),
        encodeUnknownJson({
          mcp: {
            servers: {
              github: {
                type: "remote",
                url: "https://private.invalid/mcp",
                headers: { Authorization: "Bearer {env:GITHUB_MCP_TOKEN}" },
                disabled: true,
              },
            },
          },
        }),
      );

      const inventory = yield* loadEnvironmentBundleServerInventory({
        cwd: root,
        openCodeMcpSources: [{ instanceId: "opencode-work", enabled: true }],
      });

      expect(inventory.mcpServers).toEqual([
        expect.objectContaining({
          serverId: "opencode:opencode-work:github",
          origin: "opencode:opencode-work:project-config",
          enabled: false,
          configurationRef: "opencode:opencode-work:mcp:github",
          credentialRefs: [{ kind: "environment-variable", id: "GITHUB_MCP_TOKEN" }],
        }),
      ]);
      expect(encodeUnknownJson(inventory)).not.toContain("private.invalid");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
