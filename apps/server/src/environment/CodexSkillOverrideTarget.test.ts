import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  loadCodexSkillOverrideTargetState,
  rollbackCodexSkillDisableOverrides,
  writeCodexSkillDisableOverrides,
} from "./CodexSkillOverrideTarget.ts";

describe("CodexSkillOverrideTarget", () => {
  it.effect("creates sorted project-local skill overrides without deleting other config", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-skill-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, ".codex", "config.toml");
      yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fileSystem.writeFileString(
        configPath,
        "# keep me\n[mcp_servers.logs]\nenabled = true\n",
      );
      const before = yield* loadCodexSkillOverrideTargetState(cwd);
      const result = yield* writeCodexSkillDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        skillPaths: ["C:\\skills\\zeta\\SKILL.md", "C:\\skills\\alpha\\SKILL.md"],
      });

      expect(result.written.contents).toContain("# keep me");
      expect(result.written.contents).toContain("[mcp_servers.logs]");
      expect(result.written.contents).toContain('path = "C:\\\\skills\\\\alpha\\\\SKILL.md"');
      expect(result.written.contents).toContain("enabled = false");
      expect(result.written.contents.indexOf("alpha")).toBeLessThan(
        result.written.contents.indexOf("zeta"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("updates an existing override while preserving comments and sibling entries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-skill-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, ".codex", "config.toml");
      yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fileSystem.writeFileString(
        configPath,
        [
          "[[skills.config]]",
          'path = "C:\\\\skills\\\\deploy\\\\SKILL.md" # exact destination',
          "enabled = true # switch only this value",
          "",
          "[[skills.config]]",
          'path = "C:\\\\skills\\\\keep\\\\SKILL.md"',
          "enabled = true",
          "",
        ].join("\n"),
      );
      const before = yield* loadCodexSkillOverrideTargetState(cwd);
      const result = yield* writeCodexSkillDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        skillPaths: ["C:\\skills\\deploy\\SKILL.md"],
      });

      expect(result.written.contents).toContain("enabled = false # switch only this value");
      expect(result.written.contents).toContain("# exact destination");
      expect(result.written.contents.match(/enabled = true/g)).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects malformed, duplicate, and drifted targets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-skill-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, ".codex", "config.toml");
      yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fileSystem.writeFileString(configPath, "[[skills.config]]\npath = 42\n");
      expect((yield* loadCodexSkillOverrideTargetState(cwd).pipe(Effect.flip)).reason).toBe(
        "invalid-toml",
      );

      yield* fileSystem.writeFileString(
        configPath,
        '[[skills.config]]\npath = "C:/same/SKILL.md"\n[[skills.config]]\npath = "C:/same/SKILL.md"\n',
      );
      expect((yield* loadCodexSkillOverrideTargetState(cwd).pipe(Effect.flip)).reason).toBe(
        "invalid-toml",
      );

      yield* fileSystem.writeFileString(configPath, "# before\n");
      const before = yield* loadCodexSkillOverrideTargetState(cwd);
      yield* fileSystem.writeFileString(configPath, "# concurrent\n");
      const drift = yield* writeCodexSkillDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        skillPaths: ["C:/skills/deploy/SKILL.md"],
      }).pipe(Effect.flip);
      expect(drift.reason).toBe("state-changed");
      expect(yield* fileSystem.readFileString(configPath)).toBe("# concurrent\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls a newly created project config back only from the exact written state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-skill-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const before = yield* loadCodexSkillOverrideTargetState(cwd);
      const applied = yield* writeCodexSkillDisableOverrides({
        cwd,
        expectedStateHash: before.stateHash,
        skillPaths: ["C:/skills/deploy/SKILL.md"],
      });
      yield* rollbackCodexSkillDisableOverrides({
        cwd,
        expectedWrittenStateHash: applied.written.stateHash,
        previous: applied.previous,
      });
      expect(yield* fileSystem.exists(path.join(cwd, ".codex", "config.toml"))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
