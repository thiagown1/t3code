import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentBundle, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { applyEnvironmentBundle, planEnvironmentBundleApply } from "./EnvironmentBundleApply.ts";
import { loadEnvironmentBundleServerInventory } from "./EnvironmentBundleInventory.ts";

const skill = {
  skillId: "claudeAgent:project:deploy",
  name: "deploy",
  origin: "project" as const,
  enabled: true,
  logicalPath: ".claude/skills/deploy/SKILL.md",
};

function bundle(enabled: boolean): EnvironmentBundle {
  return {
    schemaVersion: 1,
    bundleId: "source",
    name: "Source",
    capabilityProfile: {
      schemaVersion: 1,
      profileId: "profile",
      name: "Profile",
      capabilities: [],
    },
    mcpServers: [],
    skills: [{ ...skill, enabled }],
    pluginsAndApps: [],
    providers: [{ instanceId: "claudeAgent", driver: "claudeAgent", enabled: true }],
    projectInstructions: [],
  };
}

function provider(enabled: boolean): ServerProvider {
  return {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-15T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    workspaceSnapshots: [
      {
        cwd: "C:\\placeholder",
        checkedAt: "2026-09-15T00:00:00.000Z",
        slashCommands: [],
        skills: [
          {
            name: "deploy",
            path: "C:\\placeholder\\.claude\\skills\\deploy\\SKILL.md",
            scope: "project",
            enabled,
          },
        ],
      },
    ],
  } as unknown as ServerProvider;
}

function forCwd(snapshot: ServerProvider, cwd: string): ServerProvider {
  return {
    ...snapshot,
    ...(snapshot.workspaceSnapshots
      ? {
          workspaceSnapshots: snapshot.workspaceSnapshots.map((workspace) => ({
            ...workspace,
            cwd,
          })),
        }
      : {}),
  };
}

const emptyServerInventory = {
  mcpServers: [],
  mcpCoverage: "partial" as const,
  projectInstructions: [],
  projectInstructionsCoverage: "partial" as const,
};

describe("EnvironmentBundleApply", () => {
  it.effect("writes, refreshes, and verifies a Claude project MCP disable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-mcp-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      yield* fileSystem.writeFileString(
        path.join(cwd, ".mcp.json"),
        '{ "mcpServers": { "firebase": { "command": "private-command" } } }\n',
      );
      const providers = [forCwd(provider(true), cwd)];
      const getServerInventory = loadEnvironmentBundleServerInventory({
        cwd,
        claudeMcpSources: [{ instanceId: "claudeAgent", enabled: true }],
      });
      const beforeInventory = yield* getServerInventory;
      const inventoryReads = yield* Ref.make(0);
      const refreshedServerInventory = Ref.getAndUpdate(inventoryReads, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 0 ? Effect.succeed(beforeInventory) : getServerInventory,
        ),
      );
      const current = { ...bundle(true), skills: [], mcpServers: beforeInventory.mcpServers };
      const incoming = {
        ...current,
        mcpServers: current.mcpServers.map((server) => ({ ...server, enabled: false })),
      };
      const expectedPlan = yield* planEnvironmentBundleApply({
        current,
        incoming,
        providers,
        serverInventory: beforeInventory,
        cwd,
      });

      const result = yield* applyEnvironmentBundle({
        current,
        incoming,
        expectedPlan,
        cwd,
        getProviders: Effect.succeed(providers),
        getServerInventory: refreshedServerInventory,
        refreshWorkspaceSnapshot: () => Effect.succeed(providers),
      });

      expect(result.appliedOperations).toEqual([
        expect.objectContaining({ component: "mcp", serverName: "firebase" }),
      ]);
      expect(
        yield* fileSystem.readFileString(path.join(cwd, ".claude", "settings.local.json")),
      ).toContain('"disabledMcpjsonServers"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes, refreshes, and verifies a Claude skill disable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-apply-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const before = [forCwd(provider(true), cwd)];
      const expectedPlan = yield* planEnvironmentBundleApply({
        current: bundle(true),
        incoming: bundle(false),
        providers: before,
        serverInventory: emptyServerInventory,
        cwd,
      });
      const result = yield* applyEnvironmentBundle({
        current: bundle(true),
        incoming: bundle(false),
        expectedPlan,
        cwd,
        getProviders: Effect.succeed(before),
        getServerInventory: Effect.succeed(emptyServerInventory),
        refreshWorkspaceSnapshot: () => Effect.succeed([forCwd(provider(false), cwd)]),
      });
      expect(result.refreshedProviderInstanceIds).toEqual(["claudeAgent"]);
      expect(
        yield* fileSystem.readFileString(path.join(cwd, ".claude", "settings.local.json")),
      ).toContain('"deploy": "off"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back when the refreshed provider does not report the skill disabled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-apply-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const before = [forCwd(provider(true), cwd)];
      const expectedPlan = yield* planEnvironmentBundleApply({
        current: bundle(true),
        incoming: bundle(false),
        providers: before,
        serverInventory: emptyServerInventory,
        cwd,
      });
      const error = yield* applyEnvironmentBundle({
        current: bundle(true),
        incoming: bundle(false),
        expectedPlan,
        cwd,
        getProviders: Effect.succeed(before),
        getServerInventory: Effect.succeed(emptyServerInventory),
        refreshWorkspaceSnapshot: () => Effect.succeed(before),
      }).pipe(Effect.flip);
      expect(error.reason).toBe("health-check-failed");
      expect(yield* fileSystem.exists(path.join(cwd, ".claude", "settings.local.json"))).toBe(
        false,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a stale confirmation after the target file changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-apply-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const before = [forCwd(provider(true), cwd)];
      const expectedPlan = yield* planEnvironmentBundleApply({
        current: bundle(true),
        incoming: bundle(false),
        providers: before,
        serverInventory: emptyServerInventory,
        cwd,
      });
      const settingsPath = path.join(cwd, ".claude", "settings.local.json");
      yield* fileSystem.makeDirectory(path.dirname(settingsPath), { recursive: true });
      yield* fileSystem.writeFileString(settingsPath, '{ "userChange": true }\n');
      const error = yield* applyEnvironmentBundle({
        current: bundle(true),
        incoming: bundle(false),
        expectedPlan,
        cwd,
        getProviders: Effect.succeed(before),
        getServerInventory: Effect.succeed(emptyServerInventory),
        refreshWorkspaceSnapshot: () => Effect.succeed([forCwd(provider(false), cwd)]),
      }).pipe(Effect.flip);
      expect(error.reason).toBe("plan-changed");
      expect(yield* fileSystem.readFileString(settingsPath)).toBe('{ "userChange": true }\n');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
