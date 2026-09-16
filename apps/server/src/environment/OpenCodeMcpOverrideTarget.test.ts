import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";

import {
  loadOpenCodeMcpOverrideTargetState,
  rollbackOpenCodeMcpDisableOverrides,
  writeOpenCodeMcpDisableOverrides,
} from "./OpenCodeMcpOverrideTarget.ts";

describe("OpenCodeMcpOverrideTarget", () => {
  it.effect("preserves JSONC comments, executable configuration, secrets, and unknown fields", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-mcp-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, "opencode.jsonc");
      const original =
        '{\n  // keep me\n  "unknown": { "preserved": true },\n  "mcp": {\n    "servers": {\n      "firebase": {\n        "type": "local",\n        "command": ["secret-command"],\n        "environment": { "TOKEN": "secret-value" },\n      },\n    },\n  },\n}\n';
      yield* fileSystem.writeFileString(configPath, original);

      const before = yield* loadOpenCodeMcpOverrideTargetState(cwd);
      const applied = yield* writeOpenCodeMcpDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        serverNames: ["firebase"],
      });

      expect(applied.written.contents).toContain("// keep me");
      expect(applied.written.contents).toContain('"unknown"');
      expect(applied.written.contents).toContain('"secret-command"');
      expect(applied.written.contents).toContain('"secret-value"');
      expect(applied.written.contents).toContain('"disabled": true');
      expect(applied.written.filePath).toBe(configPath);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("supports the legacy direct MCP object without changing another server", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-mcp-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, "opencode.json");
      yield* fileSystem.writeFileString(
        configPath,
        '{"mcp":{"firebase":{"type":"local"},"logs":{"type":"remote","disabled":false}}}\n',
      );

      const before = yield* loadOpenCodeMcpOverrideTargetState(cwd);
      const applied = yield* writeOpenCodeMcpDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        serverNames: ["firebase"],
      });

      expect(applied.written.contents).toContain('"firebase": {');
      expect(applied.written.contents).toContain('"disabled": true');
      expect(parseJsonc(applied.written.contents)).toMatchObject({
        mcp: { logs: { type: "remote", disabled: false } },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects missing servers, malformed enablement, and concurrent drift", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-mcp-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, "opencode.jsonc");
      yield* fileSystem.writeFileString(configPath, '{ "mcp": { "firebase": {} } }\n');
      const before = yield* loadOpenCodeMcpOverrideTargetState(cwd);

      const missing = yield* writeOpenCodeMcpDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        serverNames: ["logs"],
      }).pipe(Effect.flip);
      expect(missing.reason).toBe("not-found");

      yield* fileSystem.writeFileString(
        configPath,
        '{ "mcp": { "firebase": { "disabled": "yes" } } }\n',
      );
      const malformed = yield* loadOpenCodeMcpOverrideTargetState(cwd).pipe(Effect.flip);
      expect(malformed.reason).toBe("invalid-json");

      yield* fileSystem.writeFileString(
        configPath,
        '{ "mcp": { "firebase": {} }, "drift": true }\n',
      );
      const drift = yield* writeOpenCodeMcpDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        serverNames: ["firebase"],
      }).pipe(Effect.flip);
      expect(drift.reason).toBe("state-changed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back only while the written state is still exact", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-mcp-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, "opencode.jsonc");
      const original = '{ "mcp": { "servers": { "firebase": { "type": "local" } } } }\n';
      yield* fileSystem.writeFileString(configPath, original);
      const before = yield* loadOpenCodeMcpOverrideTargetState(cwd);
      const applied = yield* writeOpenCodeMcpDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        serverNames: ["firebase"],
      });

      yield* rollbackOpenCodeMcpDisableOverrides({
        cwd,
        expectedWrittenStateHash: applied.written.stateHash,
        previous: applied.previous,
      });
      expect(yield* fileSystem.readFileString(configPath)).toBe(original);

      const reapplied = yield* writeOpenCodeMcpDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        serverNames: ["firebase"],
      });
      yield* fileSystem.writeFileString(
        configPath,
        `${reapplied.written.contents.trim()}\n// drift\n`,
      );
      const unsafeRollback = yield* rollbackOpenCodeMcpDisableOverrides({
        cwd,
        expectedWrittenStateHash: reapplied.written.stateHash,
        previous: reapplied.previous,
      }).pipe(Effect.flip);
      expect(unsafeRollback.reason).toBe("state-changed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
