import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loadEnvironmentBundleServerInventory } from "./EnvironmentBundleInventory.ts";

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

      const inventory = yield* loadEnvironmentBundleServerInventory(cwd);

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

      const inventory = yield* loadEnvironmentBundleServerInventory(cwd);

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

      const inventory = yield* loadEnvironmentBundleServerInventory(cwd);

      expect(inventory.projectInstructions).toEqual([
        { logicalPath: "AGENTS.md", contentHash: sha256("Root policy\n"), enabled: true },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
