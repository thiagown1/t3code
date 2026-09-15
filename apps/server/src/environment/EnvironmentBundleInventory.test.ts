import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  loadEnvironmentBundleServerInventory,
  parseSanitizedCodexMcpConfig,
} from "./EnvironmentBundleInventory.ts";

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

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

[mcp_servers."logs.remote"]
url = "https://example.invalid?token=do-not-export"

[mcp_servers."C:/Users/private"]
command = "do-not-export"
`);

    expect([...parsed.entries()]).toEqual([
      [
        "firebase",
        { enabled: false, allowedTools: ["delete", "query", "read"], blockedTools: ["delete"] },
      ],
      ["logs.remote", {}],
    ]);
    expect(Object.keys(parsed.get("firebase")!)).toEqual([
      "enabled",
      "allowedTools",
      "blockedTools",
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
        '[mcp_servers.firebase]\ncommand = "secret-command"\nenabled = true\nenabled_tools = ["query", "write"]\ndisabled_tools = ["write"]\n',
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
          credentialRefs: [],
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
        expect(exportedValues).not.toContain(homePath);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
