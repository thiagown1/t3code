import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentBundle, ServerProvider } from "@t3tools/contracts";

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
            path: "C:\\repo\\.claude\\skills\\deploy\\SKILL.md",
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

  it("blocks enablement and non-Claude targets", () => {
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
    const nonClaudePlan = buildEnvironmentBundleApplyPlan({
      current: bundle([codexSkill]),
      incoming: bundle([{ ...codexSkill, enabled: false }]),
      providers: [provider({ instanceId: "codex", driver: "codex" })],
      serverInventory: serverInventory(bundle([codexSkill])),
      cwd: "C:\\repo",
      targetStateHash: hash,
    });
    expect(nonClaudePlan.canApply).toBe(false);
    expect(nonClaudePlan.blockers).toContain(
      "skill:codex:project:deploy is not an enabled Claude skill in the current workspace",
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
    expect(plan.blockers).toContain("provider:claudeAgent requires an application adapter");
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
});
