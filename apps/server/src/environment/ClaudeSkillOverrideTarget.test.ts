import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  loadClaudeSkillOverrideTargetState,
  rollbackClaudeSkillDisableOverrides,
  writeClaudeSkillDisableOverrides,
} from "./ClaudeSkillOverrideTarget.ts";

describe("ClaudeSkillOverrideTarget", () => {
  it.effect("creates a project-local override without exposing an absolute path in the plan", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-skill-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const before = yield* loadClaudeSkillOverrideTargetState(cwd);
      const result = yield* writeClaudeSkillDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        skillNames: ["deploy"],
      });
      expect(result.written.contents).toContain('"skillOverrides"');
      expect(result.written.contents).toContain('"deploy": "off"');
      expect(result.written.filePath).toBe(path.join(cwd, ".claude", "settings.local.json"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves comments, unknown fields, trailing commas, and existing overrides", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-skill-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const settingsPath = path.join(cwd, ".claude", "settings.local.json");
      yield* fileSystem.makeDirectory(path.dirname(settingsPath), { recursive: true });
      yield* fileSystem.writeFileString(
        settingsPath,
        '{\n  // keep me\n  "permissions": { "allow": ["Read"] },\n  "skillOverrides": { "kept": "on", },\n}\n',
      );
      const before = yield* loadClaudeSkillOverrideTargetState(cwd);
      const result = yield* writeClaudeSkillDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        skillNames: ["zeta", "alpha"],
        mcpServerNames: ["logs", "firebase", "logs"],
      });
      expect(result.written.contents).toContain("// keep me");
      expect(result.written.contents).toContain('"permissions"');
      expect(result.written.contents).toContain('"kept": "on"');
      expect(result.written.contents).toContain('"alpha": "off"');
      expect(result.written.contents).toContain('"zeta": "off"');
      expect(result.written.contents).toContain('"disabledMcpjsonServers"');
      expect(result.written.contents.indexOf('"firebase"')).toBeLessThan(
        result.written.contents.indexOf('"logs"'),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects malformed and drifted settings instead of overwriting them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-skill-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const settingsPath = path.join(cwd, ".claude", "settings.local.json");
      yield* fileSystem.makeDirectory(path.dirname(settingsPath), { recursive: true });
      yield* fileSystem.writeFileString(settingsPath, '{ "skillOverrides": [] }');
      const malformed = yield* loadClaudeSkillOverrideTargetState(cwd).pipe(Effect.flip);
      expect(malformed.reason).toBe("invalid-json");

      yield* fileSystem.writeFileString(settingsPath, "{}\n");
      const before = yield* loadClaudeSkillOverrideTargetState(cwd);
      yield* fileSystem.writeFileString(settingsPath, '{ "changed": true }\n');
      const drift = yield* writeClaudeSkillDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        skillNames: ["deploy"],
      }).pipe(Effect.flip);
      expect(drift.reason).toBe("state-changed");
      expect(yield* fileSystem.readFileString(settingsPath)).toBe('{ "changed": true }\n');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back only while the written state is still exact", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-skill-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const before = yield* loadClaudeSkillOverrideTargetState(cwd);
      const applied = yield* writeClaudeSkillDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        skillNames: ["deploy"],
      });
      yield* rollbackClaudeSkillDisableOverrides({
        cwd,
        expectedWrittenStateHash: applied.written.stateHash,
        previous: applied.previous,
      });
      expect(yield* fileSystem.exists(path.join(cwd, ".claude", "settings.local.json"))).toBe(
        false,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
