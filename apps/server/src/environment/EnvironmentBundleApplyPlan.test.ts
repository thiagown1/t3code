import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentBundle,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { buildEnvironmentBundleApplyPlan } from "./EnvironmentBundleApplyPlan.ts";

const hash = "a".repeat(64);

function bundle(
  skills: EnvironmentBundle["skills"],
  providers?: EnvironmentBundle["providers"],
  mcpServers: EnvironmentBundle["mcpServers"] = [],
): EnvironmentBundle {
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
    mcpServers,
    skills,
    pluginsAndApps: [],
    providers: providers ?? [{ instanceId: "claudeAgent", driver: "claudeAgent", enabled: true }],
    projectInstructions: [],
  };
}

const serverInventory = (current: EnvironmentBundle) => ({
  mcpServers: current.mcpServers,
  mcpCoverage: "partial" as const,
  projectInstructions: [],
  projectInstructionsCoverage: "partial" as const,
});

function provider(input?: {
  instanceId?: string;
  driver?: string;
  skillName?: string;
  skillPath?: string;
}): ServerProvider {
  const instanceId = input?.instanceId ?? "claudeAgent";
  return {
    instanceId,
    driver: input?.driver ?? "claudeAgent",
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
        cwd: "C:\\repo",
        checkedAt: "2026-09-15T00:00:00.000Z",
        slashCommands: [],
        skills: [
          {
            name: input?.skillName ?? "deploy",
            path: input?.skillPath ?? "C:\\repo\\.claude\\skills\\deploy\\SKILL.md",
            scope: "project",
            enabled: true,
          },
        ],
      },
    ],
  } as unknown as ServerProvider;
}

const enabledSkill = {
  skillId: "claudeAgent:project:deploy",
  name: "deploy",
  origin: "project" as const,
  enabled: true,
  logicalPath: ".claude/skills/deploy/SKILL.md",
};

describe("buildEnvironmentBundleApplyPlan", () => {
  it("plans a metadata-preserving Claude skill disable", () => {
    const current = bundle([enabledSkill]);
    const incoming = bundle([{ ...enabledSkill, enabled: false }]);
    expect(
      buildEnvironmentBundleApplyPlan({
        current,
        incoming,
        providers: [provider()],
        serverInventory: serverInventory(current),
        cwd: "C:\\repo",
        targetStateHash: hash,
      }),
    ).toEqual({
      bundleId: "source",
      canApply: true,
      blockers: [],
      targetStateHash: hash,
      operations: [
        {
          component: "skill",
          operation: "disable",
          adapter: "claude-project-skill-override",
          skillName: "deploy",
          targetIds: ["claudeAgent:project:deploy"],
          providerInstanceIds: ["claudeAgent"],
          requiresProviderReload: true,
        },
      ],
    });
  });

  it("blocks skill enablement and plans a metadata-preserving Codex skill disable", () => {
    const disabled = { ...enabledSkill, enabled: false };
    const enablePlan = buildEnvironmentBundleApplyPlan({
      current: bundle([disabled]),
      incoming: bundle([enabledSkill]),
      providers: [provider()],
      serverInventory: serverInventory(bundle([disabled])),
      cwd: "C:\\repo",
      targetStateHash: hash,
    });
    expect(enablePlan.canApply).toBe(false);
    expect(enablePlan.blockers).toContain(
      "skill:claudeAgent:project:deploy supports only metadata-preserving disable",
    );

    const codexSkill = { ...enabledSkill, skillId: "codex:project:deploy" };
    const codexPlan = buildEnvironmentBundleApplyPlan({
      current: bundle([codexSkill]),
      incoming: bundle([{ ...codexSkill, enabled: false }]),
      providers: [
        provider({
          instanceId: "codex",
          driver: "codex",
          skillPath: "C:\\repo\\.agents\\skills\\deploy\\SKILL.md",
        }),
      ],
      serverInventory: serverInventory(bundle([codexSkill])),
      cwd: "C:\\repo",
      targetStateHash: hash,
    });
    expect(codexPlan).toEqual(
      expect.objectContaining({
        canApply: true,
        blockers: [],
        operations: [
          expect.objectContaining({
            component: "skill",
            adapter: "codex-project-skill-override",
            skillName: "deploy",
            targetIds: ["codex:project:deploy"],
            providerInstanceIds: ["codex"],
          }),
        ],
      }),
    );
  });

  it("blocks a project override that would silently affect another Claude instance", () => {
    const second = { ...enabledSkill, skillId: "work:project:deploy" };
    const current = bundle(
      [enabledSkill, second],
      [
        { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true },
        { instanceId: "work", driver: "claudeAgent", enabled: true },
      ],
    );
    const incoming = bundle([{ ...enabledSkill, enabled: false }, second], current.providers);
    const plan = buildEnvironmentBundleApplyPlan({
      current,
      incoming,
      providers: [provider(), provider({ instanceId: "work" })],
      serverInventory: serverInventory(current),
      cwd: "C:\\repo",
      targetStateHash: hash,
    });
    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContain("skill:deploy would also disable work:project:deploy");
  });

  it("blocks a Codex path override that would silently affect another instance", () => {
    const codexSkill = { ...enabledSkill, skillId: "codex:project:deploy" };
    const second = { ...enabledSkill, skillId: "work:project:deploy" };
    const providers = [
      { instanceId: "codex", driver: "codex", enabled: true },
      { instanceId: "work", driver: "codex", enabled: true },
    ];
    const current = bundle([codexSkill, second], providers);
    const plan = buildEnvironmentBundleApplyPlan({
      current,
      incoming: bundle([{ ...codexSkill, enabled: false }, second], providers),
      providers: [
        provider({
          instanceId: "codex",
          driver: "codex",
          skillPath: "C:\\repo\\.agents\\skills\\deploy\\SKILL.md",
        }),
        provider({
          instanceId: "work",
          driver: "codex",
          skillPath: "c:\\REPO\\.agents\\skills\\deploy\\SKILL.md",
        }),
      ],
      serverInventory: serverInventory(current),
      cwd: "C:\\repo",
      targetStateHash: hash,
    });

    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContain("skill:deploy would also disable work:project:deploy");
  });

  it("blocks unrelated mutations so application cannot become partial", () => {
    const current = bundle([enabledSkill]);
    const incoming = bundle(
      [{ ...enabledSkill, enabled: false }],
      [{ instanceId: "claudeAgent", driver: "claudeAgent", enabled: false }],
    );
    const plan = buildEnvironmentBundleApplyPlan({
      current,
      incoming,
      providers: [provider()],
      serverInventory: serverInventory(current),
      cwd: "C:\\repo",
      targetStateHash: hash,
    });
    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContain(
      "provider:claudeAgent supports only metadata-preserving enable",
    );
  });

  it("plans a metadata-preserving Claude project MCP disable", () => {
    const mcp = {
      serverId: "claude:claudeAgent:firebase",
      origin: "claude:claudeAgent:project-config",
      enabled: true,
      configurationRef: "claude:claudeAgent:mcp:firebase",
      credentialRefs: [],
      allowedTools: [],
      blockedTools: [],
    };
    const current = bundle([], undefined, [mcp]);
    const incoming = bundle([], undefined, [{ ...mcp, enabled: false }]);
    expect(
      buildEnvironmentBundleApplyPlan({
        current,
        incoming,
        providers: [provider()],
        serverInventory: serverInventory(current),
        cwd: "C:\\repo",
        targetStateHash: hash,
      }),
    ).toEqual(
      expect.objectContaining({
        canApply: true,
        blockers: [],
        operations: [
          {
            component: "mcp",
            operation: "disable",
            adapter: "claude-project-mcp-override",
            serverName: "firebase",
            targetIds: ["claude:claudeAgent:firebase"],
            providerInstanceIds: ["claudeAgent"],
            requiresProviderReload: true,
          },
        ],
      }),
    );
  });

  it("plans a metadata-preserving OpenCode project MCP disable", () => {
    const mcp = {
      serverId: "opencode:opencode:firebase",
      origin: "opencode:opencode:project-config",
      enabled: true,
      configurationRef: "opencode:opencode:mcp:firebase",
      credentialRefs: [],
      allowedTools: [],
      blockedTools: [],
    };
    const current = bundle(
      [],
      [{ instanceId: "opencode", driver: "opencode", enabled: true }],
      [mcp],
    );
    const incoming = { ...current, mcpServers: [{ ...mcp, enabled: false }] };
    expect(
      buildEnvironmentBundleApplyPlan({
        current,
        incoming,
        providers: [provider({ instanceId: "opencode", driver: "opencode" })],
        serverInventory: serverInventory(current),
        cwd: "C:\\repo",
        targetStateHash: hash,
      }),
    ).toEqual(
      expect.objectContaining({
        canApply: true,
        blockers: [],
        operations: [
          {
            component: "mcp",
            operation: "disable",
            adapter: "opencode-project-mcp-override",
            serverName: "firebase",
            targetIds: ["opencode:opencode:firebase"],
            providerInstanceIds: ["opencode"],
            requiresProviderReload: true,
          },
        ],
      }),
    );
  });

  it("blocks a batch that spans Claude and OpenCode project settings", () => {
    const claudeMcp = {
      serverId: "claude:claudeAgent:firebase",
      origin: "claude:claudeAgent:project-config",
      enabled: true,
      configurationRef: "claude:claudeAgent:mcp:firebase",
      credentialRefs: [],
      allowedTools: [],
      blockedTools: [],
    };
    const openCodeMcp = {
      ...claudeMcp,
      serverId: "opencode:opencode:logs",
      origin: "opencode:opencode:project-config",
      configurationRef: "opencode:opencode:mcp:logs",
    };
    const providers = [
      { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true },
      { instanceId: "opencode", driver: "opencode", enabled: true },
    ];
    const current = bundle([], providers, [claudeMcp, openCodeMcp]);
    const incoming = {
      ...current,
      mcpServers: current.mcpServers.map((server) => ({ ...server, enabled: false })),
    };
    const plan = buildEnvironmentBundleApplyPlan({
      current,
      incoming,
      providers: [provider(), provider({ instanceId: "opencode", driver: "opencode" })],
      serverInventory: serverInventory(current),
      cwd: "C:\\repo",
      targetStateHash: hash,
    });
    expect(plan.canApply).toBe(false);
    expect(plan.blockers).toContain(
      "Environment Bundle changes span multiple project configuration targets and cannot be applied atomically",
    );
  });

  it("plans a metadata-preserving enable for a configured legacy provider", () => {
    const current = bundle(
      [],
      [{ instanceId: "codex", driver: "codex", enabled: false, version: "1.0.0" }],
    );
    const incoming = {
      ...current,
      providers: [{ instanceId: "codex", driver: "codex", enabled: true, version: "1.0.0" }],
    };
    const disabledProvider = {
      ...provider({ instanceId: "codex", driver: "codex" }),
      enabled: false,
      status: "disabled",
    } as ServerProvider;
    const plan = buildEnvironmentBundleApplyPlan({
      current,
      incoming,
      providers: [disabledProvider],
      serverInventory: serverInventory(current),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
        },
      },
      cwd: "C:\\repo",
      targetStateHash: hash,
    });
    expect(plan).toEqual(
      expect.objectContaining({
        canApply: true,
        blockers: [],
        operations: [
          {
            component: "provider",
            operation: "enable",
            adapter: "provider-settings-enable",
            instanceId: "codex",
            driver: "codex",
            settingsTarget: "legacy",
            providerInstanceIds: ["codex"],
            requiresProviderReload: true,
            healthCheckRequired: true,
          },
        ],
      }),
    );
  });

  it("plans provider enablement through the atomic per-instance settings patch", () => {
    const current = bundle(
      [],
      [{ instanceId: "codex", driver: "codex", enabled: false, version: "1.0.0" }],
    );
    const incoming = {
      ...current,
      providers: [{ instanceId: "codex", driver: "codex", enabled: true, version: "1.0.0" }],
    };
    const plan = buildEnvironmentBundleApplyPlan({
      current,
      incoming,
      providers: [
        {
          ...provider({ instanceId: "codex", driver: "codex" }),
          enabled: false,
          status: "disabled",
        } as ServerProvider,
      ],
      serverInventory: serverInventory(current),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: {},
          },
        },
      },
      cwd: "C:\\repo",
      targetStateHash: hash,
    });
    expect(plan).toEqual(
      expect.objectContaining({
        canApply: true,
        blockers: [],
        operations: [
          expect.objectContaining({
            component: "provider",
            operation: "enable",
            instanceId: "codex",
            settingsTarget: "instance",
          }),
        ],
      }),
    );
  });
});
