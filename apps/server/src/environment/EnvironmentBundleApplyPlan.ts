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
  const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized;
}

function pluginAppIdFromSkillPath(value: string): string | undefined {
  const path = value.replaceAll("\\", "/").replace(/\/$/u, "");
  const lowerPath = path.toLowerCase();
  const marker = "/plugins/cache/";
  const start = lowerPath.indexOf(marker);
  if (start < 0) return undefined;
  const rest = path.slice(start + marker.length);
  const skillMarkerStart = rest.toLowerCase().indexOf("/skills/");
  if (skillMarkerStart <= 0) return undefined;
  const id = rest.slice(0, skillMarkerStart).split("/").filter(Boolean).join(":");
  return id || undefined;
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
          provider.driver ===
            (operation.adapter === "codex-project-skill-override" ||
            operation.adapter === "codex-project-plugin-skills-override"
              ? "codex"
              : "claudeAgent") &&
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

function verifyProjectInstructions(input: {
  readonly incoming: EnvironmentBundle;
  readonly serverInventory: EnvironmentBundleServerInventory;
}): ReadonlyArray<string> {
  if (input.incoming.projectInstructions.length === 0) return [];
  if (input.serverInventory.projectInstructionsCoverage !== "complete") {
    return ["project-instruction inventory coverage is not complete"];
  }

  const actualByPath = new Map(
    input.serverInventory.projectInstructions.map((instruction) => [
      instruction.logicalPath,
      instruction,
    ]),
  );
  const blockers: string[] = [];
  for (const instruction of input.incoming.projectInstructions) {
    if (!instruction.enabled) {
      blockers.push(`project-instruction:${instruction.logicalPath} cannot be disabled`);
      continue;
    }
    const actual = actualByPath.get(instruction.logicalPath);
    if (!actual) {
      blockers.push(
        `project-instruction:${instruction.logicalPath} is missing from current workspace`,
      );
    } else if (actual.contentHash !== instruction.contentHash || !actual.enabled) {
      blockers.push(
        `project-instruction:${instruction.logicalPath} hash differs from current workspace`,
      );
    }
  }
  return blockers;
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
        step.component !== "plugin-app" &&
        step.component !== "mcp-server" &&
        step.component !== "provider",
    )
    .map((step) => unsupportedStepMessage(step.component, step.id));
  blockers.push(...verifyProjectInstructions(input));
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
  const pluginManagedSkillIds = new Set<string>();
  const requestedPluginDisables = new Map(
    diff.pluginsAndApps.changed.map((change) => [
      `${change.after.kind}:${change.after.integrationId}`,
      change,
    ]),
  );
  for (const [pluginKey, change] of requestedPluginDisables) {
    if (
      !change.before.enabled ||
      change.after.enabled ||
      !equalExceptEnabled(change.before, change.after)
    ) {
      blockers.push(`plugin-app:${pluginKey} supports only metadata-preserving disable`);
      requestedPluginDisables.delete(pluginKey);
    }
  }
  for (const plugin of diff.pluginsAndApps.added)
    blockers.push(unsupportedStepMessage("plugin-app", `${plugin.kind}:${plugin.integrationId}`));
  for (const plugin of diff.pluginsAndApps.removed)
    blockers.push(unsupportedStepMessage("plugin-app", `${plugin.kind}:${plugin.integrationId}`));

  for (const plugin of input.incoming.pluginsAndApps) {
    const providedSkills = input.incoming.skills.filter(
      (skill) => skill.providedByPluginId === plugin.integrationId,
    );
    if (
      providedSkills.length === 0 ||
      providedSkills.some((skill) => skill.enabled) !== plugin.enabled
    ) {
      blockers.push(
        `plugin-app:${plugin.kind}:${plugin.integrationId} must ${plugin.enabled ? "keep at least one" : "disable every"} provided skill in the same bundle`,
      );
    }
  }

  for (const [pluginKey, { after }] of requestedPluginDisables) {
    const declaredSkills = input.current.skills.filter(
      (skill) => skill.providedByPluginId === after.integrationId,
    );
    const incomingSkills = new Map(input.incoming.skills.map((skill) => [skill.skillId, skill]));
    if (
      declaredSkills.length === 0 ||
      declaredSkills.some((skill) => {
        const incoming = incomingSkills.get(skill.skillId);
        return (
          skill.origin !== "plugin" ||
          !incoming ||
          incoming.enabled ||
          !equalExceptEnabled(skill, incoming)
        );
      })
    ) {
      blockers.push(`plugin-app:${pluginKey} must disable every provided skill in the same bundle`);
      continue;
    }

    const actualSkills = input.providers.flatMap((provider) =>
      provider.driver !== "codex"
        ? []
        : environmentBundleProviderSkills(provider, input.cwd).flatMap((skill) =>
            pluginAppIdFromSkillPath(skill.path) === after.integrationId
              ? [
                  {
                    provider,
                    skill,
                    targetId: environmentBundleProviderSkillId(provider, skill),
                  },
                ]
              : [],
          ),
    );
    const declaredById = new Map(declaredSkills.map((skill) => [skill.skillId, skill]));
    if (
      actualSkills.length !== declaredSkills.length ||
      actualSkills.some((actual) => {
        const declared = declaredById.get(actual.targetId);
        return (
          !declared ||
          declared.name !== actual.skill.name ||
          declared.enabled !== actual.skill.enabled
        );
      })
    ) {
      blockers.push(
        `plugin-app:${pluginKey} is not an enabled supported Codex app in the current workspace`,
      );
      continue;
    }
    const matches = actualSkills.filter((actual) => actual.skill.enabled);
    if (matches.length === 0) {
      blockers.push(
        `plugin-app:${pluginKey} is not an enabled supported Codex app in the current workspace`,
      );
      continue;
    }

    const declaredTargetIds = new Set(matches.map((match) => match.targetId));
    const matchedPaths = new Set(matches.map((match) => normalizedPath(match.skill.path)));
    const affected = input.providers.flatMap((provider) =>
      provider.driver !== "codex"
        ? []
        : environmentBundleProviderSkills(provider, input.cwd)
            .filter((skill) => skill.enabled && matchedPaths.has(normalizedPath(skill.path)))
            .map((skill) => ({
              instanceId: provider.instanceId,
              targetId: environmentBundleProviderSkillId(provider, skill),
            })),
    );
    const missingTargets = affected.filter(
      (candidate) => !declaredTargetIds.has(candidate.targetId),
    );
    if (missingTargets.length > 0) {
      blockers.push(
        `plugin-app:${pluginKey} would also disable ${missingTargets.map((candidate) => candidate.targetId).join(", ")}`,
      );
      continue;
    }

    for (const targetId of declaredTargetIds) pluginManagedSkillIds.add(targetId);
    operationByName.set(`plugin-app:${pluginKey}`, {
      component: "plugin-app",
      operation: "disable",
      adapter: "codex-project-plugin-skills-override",
      integrationId: after.integrationId,
      kind: after.kind,
      targetIds: [...declaredTargetIds].sort(),
      providerInstanceIds: [...new Set(affected.map((candidate) => candidate.instanceId))].sort(),
      requiresProviderReload: true,
    });
  }

  for (const { after } of requestedDisables.values()) {
    if (pluginManagedSkillIds.has(after.skillId)) continue;
    const matches = input.providers.flatMap((provider) => {
      if (provider.driver !== "claudeAgent" && provider.driver !== "codex") return [];
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
        `skill:${after.skillId} is not an enabled supported skill in the current workspace`,
      );
      continue;
    }
    if (matches.length > 1) {
      blockers.push(`skill:${after.skillId} is ambiguous in the current workspace`);
      continue;
    }
    const match = matches[0]!;
    const adapter =
      match.provider.driver === "codex"
        ? ("codex-project-skill-override" as const)
        : ("claude-project-skill-override" as const);
    const matchedPath = normalizedPath(match.skill.path);

    const affected = input.providers.flatMap((provider) =>
      provider.driver !== match.provider.driver
        ? []
        : environmentBundleProviderSkills(provider, input.cwd)
            .filter(
              (skill) =>
                skill.enabled &&
                (adapter === "claude-project-skill-override"
                  ? skill.name === after.name
                  : normalizedPath(skill.path) === matchedPath),
            )
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

    operationByName.set(
      adapter === "claude-project-skill-override"
        ? `skill:claude:${after.name}`
        : `skill:codex:${matchedPath}`,
      {
        component: "skill",
        operation: "disable",
        adapter,
        skillName: after.name,
        targetIds: affected.map((candidate) => candidate.targetId).sort(),
        providerInstanceIds: [...new Set(affected.map((candidate) => candidate.instanceId))].sort(),
        requiresProviderReload: true,
      },
    );
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
    if (operation.component === "plugin-app")
      return `plugin-app:${operation.kind}:${operation.integrationId}`;
    if (operation.component === "skill")
      return `skill:${operation.adapter}:${operation.targetIds.join(",")}`;
    if (operation.component === "mcp") return `mcp:${operation.serverName}`;
    return `provider:${operation.instanceId}`;
  };
  const operations = [...operationByName.values()].sort((left, right) =>
    operationKey(left).localeCompare(operationKey(right)),
  );
  const targetKinds = new Set(
    operations.map((operation) => {
      if (operation.adapter === "opencode-project-mcp-override") return "opencode";
      if (
        operation.adapter === "codex-project-skill-override" ||
        operation.adapter === "codex-project-plugin-skills-override"
      )
        return "codex";
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
