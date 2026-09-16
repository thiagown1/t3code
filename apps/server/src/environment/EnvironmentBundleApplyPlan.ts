import { isDeepStrictEqual } from "node:util";

import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  EnvironmentBundle,
  EnvironmentBundleApplyOperation,
  EnvironmentBundleApplyPlan,
  EnvironmentBundleServerInventory,
  ServerSettings,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  buildEnvironmentBundleApplicationPlan,
  diffEnvironmentBundles,
} from "@t3tools/shared/environmentBundle";

type SkillOrigin = EnvironmentBundle["skills"][number]["origin"];

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/u, "");
}

function skillOrigin(skill: Pick<ServerProviderSkill, "path" | "scope">): SkillOrigin {
  const path = normalizedPath(skill.path);
  if (path.includes("/.codex/plugins/") || path.includes("/.agents/plugins/")) return "plugin";
  switch (skill.scope?.trim().toLowerCase()) {
    case "repo":
    case "repository":
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "local";
    case "system":
      return "local";
    default:
      return "provider";
  }
}

export function environmentBundleProviderSkills(
  provider: ServerProvider,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  return (
    provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.skills ?? provider.skills
  );
}

export function environmentBundleProviderSkillId(
  provider: ServerProvider,
  skill: ServerProviderSkill,
): string {
  return `${provider.instanceId}:${skillOrigin(skill)}:${skill.name}`;
}

export function areEnvironmentBundleApplyOperationsEffective(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly serverInventory: EnvironmentBundleServerInventory;
  readonly cwd: string;
  readonly operations: ReadonlyArray<EnvironmentBundleApplyOperation>;
}): boolean {
  return input.operations.every((operation) => {
    if (operation.component === "provider") {
      return input.providers.some(
        (provider) =>
          provider.instanceId === operation.instanceId &&
          provider.driver === operation.driver &&
          provider.enabled &&
          provider.installed &&
          provider.availability !== "unavailable" &&
          provider.status === "ready" &&
          provider.auth.status !== "unauthenticated",
      );
    }
    if (operation.component === "mcp") {
      return operation.targetIds.every((targetId) =>
        input.serverInventory.mcpServers.some(
          (server) => server.serverId === targetId && !server.enabled,
        ),
      );
    }
    return operation.targetIds.every((targetId) =>
      input.providers.some(
        (provider) =>
          provider.driver === "claudeAgent" &&
          environmentBundleProviderSkills(provider, input.cwd).some(
            (skill) =>
              environmentBundleProviderSkillId(provider, skill) === targetId && !skill.enabled,
          ),
      ),
    );
  });
}

function equalExceptEnabled(
  before: { readonly enabled: boolean },
  after: { readonly enabled: boolean },
): boolean {
  const { enabled: _beforeEnabled, ...beforeMetadata } = before;
  const { enabled: _afterEnabled, ...afterMetadata } = after;
  return isDeepStrictEqual(beforeMetadata, afterMetadata);
}

function projectMcpIdentity(input: {
  readonly server: Pick<EnvironmentBundle["mcpServers"][number], "serverId" | "origin">;
  readonly providers: ReadonlyArray<ServerProvider>;
}): {
  readonly instanceId: string;
  readonly serverName: string;
  readonly adapter: "claude-project-mcp-override" | "opencode-project-mcp-override";
} | null {
  for (const provider of input.providers) {
    const providerPrefix =
      provider.driver === "claudeAgent"
        ? "claude"
        : provider.driver === "opencode"
          ? "opencode"
          : null;
    if (!providerPrefix) continue;
    const prefix = `${providerPrefix}:${provider.instanceId}:`;
    if (
      input.server.origin !== `${providerPrefix}:${provider.instanceId}:project-config` ||
      !input.server.serverId.startsWith(prefix)
    )
      continue;
    const serverName = input.server.serverId.slice(prefix.length);
    if (/^[a-zA-Z0-9_.-]{1,256}$/u.test(serverName)) {
      return {
        instanceId: provider.instanceId,
        serverName,
        adapter:
          provider.driver === "claudeAgent"
            ? "claude-project-mcp-override"
            : "opencode-project-mcp-override",
      };
    }
  }
  return null;
}

function unsupportedStepMessage(component: string, id: string): string {
  return `${component}:${id} requires an application adapter`;
}

export function buildEnvironmentBundleApplyPlan(input: {
  readonly current: EnvironmentBundle;
  readonly incoming: EnvironmentBundle;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly serverInventory: EnvironmentBundleServerInventory;
  readonly settings?: ServerSettings;
  readonly cwd: string;
  readonly targetStateHash: string;
}): EnvironmentBundleApplyPlan {
  const diff = diffEnvironmentBundles(input.current, input.incoming);
  const steps = buildEnvironmentBundleApplicationPlan(input.current, input.incoming);
  const blockers = steps
    .filter(
      (step) =>
        step.component !== "bundle" &&
        step.component !== "skill" &&
        step.component !== "mcp-server" &&
        step.component !== "provider",
    )
    .map((step) => unsupportedStepMessage(step.component, step.id));
  const requestedDisables = new Map<
    string,
    {
      readonly before: EnvironmentBundle["skills"][number];
      readonly after: EnvironmentBundle["skills"][number];
    }
  >();

  for (const change of diff.skills.changed) {
    if (
      !change.before.enabled ||
      change.after.enabled ||
      !equalExceptEnabled(change.before, change.after)
    ) {
      blockers.push(`skill:${change.after.skillId} supports only metadata-preserving disable`);
      continue;
    }
    requestedDisables.set(change.after.skillId, change);
  }
  for (const skill of diff.skills.added)
    blockers.push(unsupportedStepMessage("skill", skill.skillId));
  for (const skill of diff.skills.removed)
    blockers.push(unsupportedStepMessage("skill", skill.skillId));

  const operationByName = new Map<string, EnvironmentBundleApplyOperation>();
  for (const { after } of requestedDisables.values()) {
    const matches = input.providers.flatMap((provider) => {
      if (provider.driver !== "claudeAgent") return [];
      const skill = environmentBundleProviderSkills(provider, input.cwd).find(
        (candidate) =>
          candidate.enabled &&
          candidate.name === after.name &&
          environmentBundleProviderSkillId(provider, candidate) === after.skillId,
      );
      return skill ? [{ provider, skill }] : [];
    });
    if (matches.length === 0) {
      blockers.push(
        `skill:${after.skillId} is not an enabled Claude skill in the current workspace`,
      );
      continue;
    }

    const affected = input.providers.flatMap((provider) =>
      provider.driver !== "claudeAgent"
        ? []
        : environmentBundleProviderSkills(provider, input.cwd)
            .filter((skill) => skill.enabled && skill.name === after.name)
            .map((skill) => ({
              instanceId: provider.instanceId,
              targetId: environmentBundleProviderSkillId(provider, skill),
            })),
    );
    const missingTargets = affected.filter(
      (candidate) => !requestedDisables.has(candidate.targetId),
    );
    if (missingTargets.length > 0) {
      blockers.push(
        `skill:${after.name} would also disable ${missingTargets.map((candidate) => candidate.targetId).join(", ")}`,
      );
      continue;
    }

    operationByName.set(`skill:${after.name}`, {
      component: "skill",
      operation: "disable",
      adapter: "claude-project-skill-override",
      skillName: after.name,
      targetIds: affected.map((candidate) => candidate.targetId).sort(),
      providerInstanceIds: [...new Set(affected.map((candidate) => candidate.instanceId))].sort(),
      requiresProviderReload: true,
    });
  }

  const requestedMcpDisables = new Map(
    diff.mcpServers.changed.map((change) => [change.after.serverId, change] as const),
  );
  for (const change of diff.mcpServers.changed) {
    if (
      !change.before.enabled ||
      change.after.enabled ||
      !equalExceptEnabled(change.before, change.after)
    ) {
      blockers.push(`mcp:${change.after.serverId} supports only metadata-preserving disable`);
      requestedMcpDisables.delete(change.after.serverId);
      continue;
    }
    const actual = input.serverInventory.mcpServers.find(
      (server) => server.serverId === change.before.serverId,
    );
    const identity = projectMcpIdentity({
      server: change.after,
      providers: input.providers,
    });
    if (!actual || !actual.enabled || !isDeepStrictEqual(actual, change.before) || !identity) {
      blockers.push(
        `mcp:${change.after.serverId} is not an enabled supported project MCP in the current workspace`,
      );
      requestedMcpDisables.delete(change.after.serverId);
      continue;
    }
  }
  for (const server of diff.mcpServers.added)
    blockers.push(unsupportedStepMessage("mcp", server.serverId));
  for (const server of diff.mcpServers.removed)
    blockers.push(unsupportedStepMessage("mcp", server.serverId));

  for (const { after } of requestedMcpDisables.values()) {
    const identity = projectMcpIdentity({ server: after, providers: input.providers });
    if (!identity) continue;
    const affected = input.serverInventory.mcpServers.flatMap((server) => {
      const candidate = projectMcpIdentity({
        server,
        providers: input.providers,
      });
      return server.enabled &&
        candidate?.adapter === identity.adapter &&
        candidate.serverName === identity.serverName
        ? [{ instanceId: candidate.instanceId, targetId: server.serverId }]
        : [];
    });
    const missingTargets = affected.filter(
      (candidate) => !requestedMcpDisables.has(candidate.targetId),
    );
    if (missingTargets.length > 0) {
      blockers.push(
        `mcp:${identity.serverName} would also disable ${missingTargets.map((candidate) => candidate.targetId).join(", ")}`,
      );
      continue;
    }
    operationByName.set(`mcp:${identity.adapter}:${identity.serverName}`, {
      component: "mcp",
      operation: "disable",
      adapter: identity.adapter,
      serverName: identity.serverName,
      targetIds: affected.map((candidate) => candidate.targetId).sort(),
      providerInstanceIds: [...new Set(affected.map((candidate) => candidate.instanceId))].sort(),
      requiresProviderReload: true,
    });
  }

  for (const change of diff.providers.changed) {
    const { before, after } = change;
    if (before.enabled || !after.enabled || !equalExceptEnabled(before, after)) {
      blockers.push(`provider:${after.instanceId} supports only metadata-preserving enable`);
      continue;
    }
    const actual = input.providers.find(
      (provider) => provider.instanceId === after.instanceId && provider.driver === after.driver,
    );
    if (
      !actual ||
      actual.enabled ||
      !actual.installed ||
      actual.availability === "unavailable" ||
      (actual.version ?? undefined) !== before.version
    ) {
      blockers.push(
        `provider:${after.instanceId} is not a disabled available provider in the current environment`,
      );
      continue;
    }
    if (!input.settings) {
      blockers.push(`provider:${after.instanceId} settings could not be inspected`);
      continue;
    }
    const providerInstance =
      input.settings.providerInstances[ProviderInstanceId.make(after.instanceId)];
    const legacyProvider = (
      input.settings.providers as Readonly<
        Record<string, { readonly enabled?: boolean } | undefined>
      >
    )[after.driver];
    const settingsTarget = providerInstance ? "instance" : "legacy";
    if (
      providerInstance
        ? providerInstance.driver !== after.driver || providerInstance.enabled !== false
        : after.instanceId !== after.driver || !legacyProvider || legacyProvider.enabled !== false
    ) {
      blockers.push(`provider:${after.instanceId} has no disabled settings target`);
      continue;
    }
    operationByName.set(`provider:${after.instanceId}`, {
      component: "provider",
      operation: "enable",
      adapter: "provider-settings-enable",
      instanceId: after.instanceId,
      driver: after.driver,
      settingsTarget,
      providerInstanceIds: [after.instanceId],
      requiresProviderReload: true,
      healthCheckRequired: true,
    });
  }
  for (const provider of diff.providers.added)
    blockers.push(unsupportedStepMessage("provider", provider.instanceId));
  for (const provider of diff.providers.removed)
    blockers.push(unsupportedStepMessage("provider", provider.instanceId));

  const operationKey = (operation: EnvironmentBundleApplyOperation): string => {
    if (operation.component === "skill") return `skill:${operation.skillName}`;
    if (operation.component === "mcp") return `mcp:${operation.serverName}`;
    return `provider:${operation.instanceId}`;
  };
  const operations = [...operationByName.values()].sort((left, right) =>
    operationKey(left).localeCompare(operationKey(right)),
  );
  const targetKinds = new Set(
    operations.map((operation) => {
      if (operation.adapter === "opencode-project-mcp-override") return "opencode";
      if (operation.adapter === "provider-settings-enable") return "provider-settings";
      return "claude";
    }),
  );
  if (targetKinds.size > 1) {
    blockers.push(
      "Environment Bundle changes span multiple project configuration targets and cannot be applied atomically",
    );
  }
  if (operations.length === 0 && blockers.length === 0) {
    blockers.push("The bundle does not contain any supported changes to apply");
  }
  return {
    bundleId: input.incoming.bundleId,
    canApply: operations.length > 0 && blockers.length === 0,
    operations,
    blockers: [...new Set(blockers)].sort(),
    targetStateHash: input.targetStateHash,
  };
}
