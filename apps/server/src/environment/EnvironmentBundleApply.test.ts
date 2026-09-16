import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentBundle,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
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

function providerBundle(enabled: boolean): EnvironmentBundle {
  return {
    ...bundle(true),
    skills: [],
    providers: [{ instanceId: "codex", driver: "codex", enabled, version: "1.0.0" }],
  };
}

function codexProvider(enabled: boolean, status: ServerProvider["status"]): ServerProvider {
  return {
    ...provider(true),
    instanceId: "codex",
    driver: "codex",
    enabled,
    status,
    workspaceSnapshots: [],
  } as unknown as ServerProvider;
}

function disabledCodexSettings(): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
    },
  };
}

describe("EnvironmentBundleApply", () => {
  it.effect("enables a legacy provider and keeps it enabled only after a ready health check", () =>
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(disabledCodexSettings());
      const before = [codexProvider(false, "disabled")];
      const updateSettings = (patch: ServerSettingsPatch) =>
        Ref.modify(settingsRef, (current) => {
          const next = applyServerSettingsPatch(current, patch);
          return [next, next] as const;
        });
      const expectedPlan = yield* planEnvironmentBundleApply({
        current: providerBundle(false),
        incoming: providerBundle(true),
        providers: before,
        serverInventory: emptyServerInventory,
        settings: yield* Ref.get(settingsRef),
        cwd: "C:\\repo",
      });

      const result = yield* applyEnvironmentBundle({
        current: providerBundle(false),
        incoming: providerBundle(true),
        expectedPlan,
        cwd: "C:\\repo",
        getProviders: Effect.succeed(before),
        getSettings: Ref.get(settingsRef),
        updateSettings,
        getServerInventory: Effect.succeed(emptyServerInventory),
        refreshWorkspaceSnapshot: () => Effect.succeed(before),
        refreshProviderInstance: () => Effect.succeed([codexProvider(true, "ready")]),
      });

      expect(result.appliedOperations).toEqual([
        expect.objectContaining({
          component: "provider",
          adapter: "provider-settings-enable",
          instanceId: "codex",
        }),
      ]);
      expect((yield* Ref.get(settingsRef)).providers.codex.enabled).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("enables a modern provider instance without replacing its configuration", () =>
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: { launchArgs: "--preserve" },
          },
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: {},
          },
        },
      });
      const before = [codexProvider(false, "disabled")];
      const updateSettings = (patch: ServerSettingsPatch) =>
        Ref.modify(settingsRef, (current) => {
          const next = applyServerSettingsPatch(current, patch);
          return [next, next] as const;
        });
      const expectedPlan = yield* planEnvironmentBundleApply({
        current: providerBundle(false),
        incoming: providerBundle(true),
        providers: before,
        serverInventory: emptyServerInventory,
        settings: yield* Ref.get(settingsRef),
        cwd: "C:\\repo",
      });

      yield* applyEnvironmentBundle({
        current: providerBundle(false),
        incoming: providerBundle(true),
        expectedPlan,
        cwd: "C:\\repo",
        getProviders: Effect.succeed(before),
        getSettings: Ref.get(settingsRef),
        updateSettings,
        getServerInventory: Effect.succeed(emptyServerInventory),
        refreshWorkspaceSnapshot: () => Effect.succeed(before),
        refreshProviderInstance: () => Effect.succeed([codexProvider(true, "ready")]),
      });

      const settings = yield* Ref.get(settingsRef);
      expect(settings.providerInstances[ProviderInstanceId.make("codex")]).toEqual({
        driver: "codex",
        enabled: true,
        config: { launchArgs: "--preserve" },
      });
      expect(settings.providerInstances[ProviderInstanceId.make("claudeAgent")]?.enabled).toBe(
        true,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls a provider back to disabled when the health check is not ready", () =>
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(disabledCodexSettings());
      const before = [codexProvider(false, "disabled")];
      const updateSettings = (patch: ServerSettingsPatch) =>
        Ref.modify(settingsRef, (current) => {
          const next = applyServerSettingsPatch(current, patch);
          return [next, next] as const;
        });
      const expectedPlan = yield* planEnvironmentBundleApply({
        current: providerBundle(false),
        incoming: providerBundle(true),
        providers: before,
        serverInventory: emptyServerInventory,
        settings: yield* Ref.get(settingsRef),
        cwd: "C:\\repo",
      });

      const error = yield* applyEnvironmentBundle({
        current: providerBundle(false),
        incoming: providerBundle(true),
        expectedPlan,
        cwd: "C:\\repo",
        getProviders: Effect.succeed(before),
        getSettings: Ref.get(settingsRef),
        updateSettings,
        getServerInventory: Effect.succeed(emptyServerInventory),
        refreshWorkspaceSnapshot: () => Effect.succeed(before),
        refreshProviderInstance: () => Effect.succeed([codexProvider(true, "error")]),
      }).pipe(Effect.flip);

      expect(error.reason).toBe("health-check-failed");
      expect((yield* Ref.get(settingsRef)).providers.codex.enabled).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not overwrite a concurrent provider edit during rollback", () =>
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(disabledCodexSettings());
      const before = [codexProvider(false, "disabled")];
      const updateSettings = (patch: ServerSettingsPatch) =>
        Ref.modify(settingsRef, (current) => {
          const next = applyServerSettingsPatch(current, patch);
          return [next, next] as const;
        });
      const expectedPlan = yield* planEnvironmentBundleApply({
        current: providerBundle(false),
        incoming: providerBundle(true),
        providers: before,
        serverInventory: emptyServerInventory,
        settings: yield* Ref.get(settingsRef),
        cwd: "C:\\repo",
      });

      const error = yield* applyEnvironmentBundle({
        current: providerBundle(false),
        incoming: providerBundle(true),
        expectedPlan,
        cwd: "C:\\repo",
        getProviders: Effect.succeed(before),
        getSettings: Ref.get(settingsRef),
        updateSettings,
        getServerInventory: Effect.succeed(emptyServerInventory),
        refreshWorkspaceSnapshot: () => Effect.succeed(before),
        refreshProviderInstance: () =>
          updateSettings({ providers: { codex: { launchArgs: "--concurrent-edit" } } }).pipe(
            Effect.as([codexProvider(true, "error")]),
          ),
      }).pipe(Effect.flip);

      expect(error.reason).toBe("rollback-failed");
      const settings = yield* Ref.get(settingsRef);
      expect(settings.providers.codex.enabled).toBe(true);
      expect(settings.providers.codex.launchArgs).toBe("--concurrent-edit");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes, refreshes, and verifies an OpenCode project MCP disable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-opencode-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, "opencode.jsonc");
      yield* fileSystem.writeFileString(
        configPath,
        '{ "mcp": { "servers": { "firebase": { "type": "local", "command": ["private-command"] } } } }\n',
      );
      const providers = [
        {
          ...forCwd(provider(true), cwd),
          instanceId: "opencode",
          driver: "opencode",
          workspaceSnapshots: [],
        } as unknown as ServerProvider,
      ];
      const getServerInventory = loadEnvironmentBundleServerInventory({
        cwd,
        openCodeMcpSources: [{ instanceId: "opencode", enabled: true }],
      });
      const beforeInventory = yield* getServerInventory;
      const inventoryReads = yield* Ref.make(0);
      const refreshedServerInventory = Ref.getAndUpdate(inventoryReads, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 0 ? Effect.succeed(beforeInventory) : getServerInventory,
        ),
      );
      const current: EnvironmentBundle = {
        ...bundle(true),
        mcpServers: beforeInventory.mcpServers,
        skills: [],
        providers: [{ instanceId: "opencode", driver: "opencode", enabled: true }],
      };
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
        expect.objectContaining({
          component: "mcp",
          adapter: "opencode-project-mcp-override",
          serverName: "firebase",
        }),
      ]);
      const persisted = yield* fileSystem.readFileString(configPath);
      expect(persisted).toContain('"disabled": true');
      expect(persisted).toContain('"private-command"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back an OpenCode MCP disable when refreshed inventory stays enabled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-opencode-" });
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
      const configPath = path.join(cwd, "opencode.jsonc");
      const original =
        '{ "mcp": { "servers": { "firebase": { "type": "local", "command": ["private-command"] } } } }\n';
      yield* fileSystem.writeFileString(configPath, original);
      const providers = [
        {
          ...forCwd(provider(true), cwd),
          instanceId: "opencode",
          driver: "opencode",
          workspaceSnapshots: [],
        } as unknown as ServerProvider,
      ];
      const beforeInventory = yield* loadEnvironmentBundleServerInventory({
        cwd,
        openCodeMcpSources: [{ instanceId: "opencode", enabled: true }],
      });
      const current: EnvironmentBundle = {
        ...bundle(true),
        mcpServers: beforeInventory.mcpServers,
        skills: [],
        providers: [{ instanceId: "opencode", driver: "opencode", enabled: true }],
      };
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

      const error = yield* applyEnvironmentBundle({
        current,
        incoming,
        expectedPlan,
        cwd,
        getProviders: Effect.succeed(providers),
        getServerInventory: Effect.succeed(beforeInventory),
        refreshWorkspaceSnapshot: () => Effect.succeed(providers),
      }).pipe(Effect.flip);

      expect(error.reason).toBe("health-check-failed");
      expect(yield* fileSystem.readFileString(configPath)).toBe(original);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
