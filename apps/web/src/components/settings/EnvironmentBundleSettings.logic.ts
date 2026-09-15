import {
  type EnvironmentBundle,
  type EnvironmentBundleServerInventory,
  type PortableCapabilityProfile,
  type ProviderInstanceConfig,
  type ServerProviderSkill,
  type ServerProviderWorkspaceSnapshot,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { resolveProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import {
  buildEnvironmentBundleApplicationPlan,
  diffEnvironmentBundles,
} from "@t3tools/shared/environmentBundle";

interface InventoryProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly version: string | null;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly workspaceSnapshots?: ReadonlyArray<ServerProviderWorkspaceSnapshot>;
}

export type EnvironmentBundleEnablementComponent =
  | "capability"
  | "mcp-server"
  | "skill"
  | "plugin-app"
  | "provider"
  | "project-instruction";

export interface EnvironmentBundleEnablementTarget {
  readonly component: EnvironmentBundleEnablementComponent;
  readonly id: string;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/, "");
}

function relativeProjectSkillPath(skillPath: string, cwd: string | null): string | undefined {
  if (!cwd) return undefined;
  const root = normalizedPath(cwd);
  const path = normalizedPath(skillPath);
  if (!path.startsWith(`${root}/`)) return undefined;
  const relative = path.slice(root.length + 1);
  return relative.length > 0 && !relative.split("/").includes("..") ? relative : undefined;
}

function pluginAppId(skillPath: string): string | undefined {
  const path = normalizedPath(skillPath);
  const marker = "/plugins/cache/";
  const start = path.indexOf(marker);
  if (start < 0) return undefined;
  const rest = path.slice(start + marker.length);
  const skillMarker = "/skills/";
  const end = rest.indexOf(skillMarker);
  if (end <= 0) return undefined;
  const id = rest.slice(0, end).split("/").filter(Boolean).join(":");
  return id || undefined;
}

function bundleSkillOrigin(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): EnvironmentBundle["skills"][number]["origin"] {
  switch (resolveProviderSkillSourceKind(skill)) {
    case "app":
      return "plugin";
    case "repo":
    case "project":
      return "project";
    case "personal":
    case "system":
      return "local";
    case "other":
      return "provider";
  }
}

function emptyCapabilityProfile(
  environmentId: string,
  environmentLabel: string,
): PortableCapabilityProfile {
  return {
    schemaVersion: 1,
    profileId: environmentId,
    name: environmentLabel,
    capabilities: [],
  };
}

export function environmentBundleCapabilityId(
  declaration: EnvironmentBundle["capabilityProfile"]["capabilities"][number],
): string {
  const scope = declaration.scope;
  return [
    declaration.capabilityId,
    scope?.environment ?? "*",
    scope?.project ?? "*",
    scope?.provider ?? "*",
    scope?.integration ?? "*",
  ].join("|");
}

function updateEnvironmentBundleEntry<Value>(input: {
  readonly values: ReadonlyArray<Value>;
  readonly id: string;
  readonly keyOf: (value: Value) => string;
  readonly update: (value: Value) => Value;
  readonly label: string;
}): Array<Value> {
  let found = false;
  const values = input.values.map((value) => {
    if (input.keyOf(value) !== input.id) return value;
    found = true;
    return input.update(value);
  });
  if (!found) throw new Error(`Environment Bundle ${input.label} not found: ${input.id}`);
  return values;
}

/**
 * Changes only the in-memory bundle being reviewed. Destination adapters are
 * deliberately not involved until a separately confirmed apply phase exists.
 */
export function setEnvironmentBundleEntryEnabled(
  bundle: EnvironmentBundle,
  target: EnvironmentBundleEnablementTarget,
  enabled: boolean,
): EnvironmentBundle {
  switch (target.component) {
    case "capability":
      return {
        ...bundle,
        capabilityProfile: {
          ...bundle.capabilityProfile,
          capabilities: updateEnvironmentBundleEntry({
            values: bundle.capabilityProfile.capabilities,
            id: target.id,
            keyOf: environmentBundleCapabilityId,
            update: (entry) => ({ ...entry, state: enabled ? "enabled" : "disabled" }),
            label: "capability",
          }),
        },
      };
    case "mcp-server":
      return {
        ...bundle,
        mcpServers: updateEnvironmentBundleEntry({
          values: bundle.mcpServers,
          id: target.id,
          keyOf: (entry) => entry.serverId,
          update: (entry) => ({ ...entry, enabled }),
          label: "MCP server",
        }),
      };
    case "skill":
      return {
        ...bundle,
        skills: updateEnvironmentBundleEntry({
          values: bundle.skills,
          id: target.id,
          keyOf: (entry) => entry.skillId,
          update: (entry) => ({ ...entry, enabled }),
          label: "skill",
        }),
      };
    case "plugin-app":
      return {
        ...bundle,
        pluginsAndApps: updateEnvironmentBundleEntry({
          values: bundle.pluginsAndApps,
          id: target.id,
          keyOf: (entry) => `${entry.kind}:${entry.integrationId}`,
          update: (entry) => ({ ...entry, enabled }),
          label: "plugin/app",
        }),
      };
    case "provider":
      return {
        ...bundle,
        providers: updateEnvironmentBundleEntry({
          values: bundle.providers,
          id: target.id,
          keyOf: (entry) => entry.instanceId,
          update: (entry) => ({ ...entry, enabled }),
          label: "provider",
        }),
      };
    case "project-instruction":
      return {
        ...bundle,
        projectInstructions: updateEnvironmentBundleEntry({
          values: bundle.projectInstructions,
          id: target.id,
          keyOf: (entry) => entry.logicalPath,
          update: (entry) => ({ ...entry, enabled }),
          label: "project instruction",
        }),
      };
  }
}

export function buildEnvironmentBundleInventory(input: {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly cwd: string | null;
  readonly capabilityProfile: PortableCapabilityProfile | null;
  readonly providers: ReadonlyArray<InventoryProvider>;
  readonly serverInventory?: EnvironmentBundleServerInventory;
}): EnvironmentBundle {
  const skills = new Map<string, EnvironmentBundle["skills"][number]>();
  const pluginsAndApps = new Map<string, EnvironmentBundle["pluginsAndApps"][number]>();

  for (const provider of input.providers) {
    const workspaceSkills = input.cwd
      ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === input.cwd)?.skills
      : undefined;
    for (const skill of workspaceSkills ?? provider.skills) {
      const origin = bundleSkillOrigin(skill);
      const appId = origin === "plugin" ? pluginAppId(skill.path) : undefined;
      const skillId = `${provider.instanceId}:${origin}:${skill.name}`;
      const previous = skills.get(skillId);
      const logicalPath =
        origin === "project" ? relativeProjectSkillPath(skill.path, input.cwd) : undefined;
      skills.set(skillId, {
        skillId,
        name: skill.name,
        origin,
        enabled: skill.enabled || previous?.enabled === true,
        ...(logicalPath ? { logicalPath } : {}),
        ...(appId ? { providedByPluginId: appId } : {}),
      });
      if (appId) {
        pluginsAndApps.set(appId, {
          integrationId: appId,
          kind: "app",
          enabled: skill.enabled || pluginsAndApps.get(appId)?.enabled === true,
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    bundleId: input.environmentId,
    name: input.environmentLabel,
    capabilityProfile:
      input.capabilityProfile ??
      emptyCapabilityProfile(input.environmentId, input.environmentLabel),
    mcpServers: input.serverInventory?.mcpServers ?? [],
    skills: [...skills.values()],
    pluginsAndApps: [...pluginsAndApps.values()],
    providers: input.providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      enabled: provider.enabled,
      ...(provider.version ? { version: provider.version } : {}),
    })),
    projectInstructions: input.serverInventory?.projectInstructions ?? [],
  };
}

export function environmentBundleDownloadName(bundle: EnvironmentBundle): string {
  const slug = bundle.bundleId
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return `t3-environment-${slug || "bundle"}.json`;
}

export function summarizeEnvironmentBundleDiff(
  current: EnvironmentBundle,
  incoming: EnvironmentBundle,
) {
  const diff = diffEnvironmentBundles(current, incoming);
  const counts = [
    diff.capabilityProfile,
    diff.mcpServers,
    diff.skills,
    diff.pluginsAndApps,
    diff.providers,
    diff.projectInstructions,
  ].reduce(
    (summary, inventory) => ({
      added: summary.added + inventory.added.length,
      changed: summary.changed + inventory.changed.length,
      removed: summary.removed + inventory.removed.length,
    }),
    { added: 0, changed: 0, removed: 0 },
  );
  return {
    ...counts,
    metadataChanged:
      diff.identityChanged ||
      diff.skillContextBudgetChanged ||
      current.capabilityProfile.profileId !== incoming.capabilityProfile.profileId ||
      current.capabilityProfile.name !== incoming.capabilityProfile.name,
    steps: buildEnvironmentBundleApplicationPlan(current, incoming),
  };
}

export interface EnvironmentBundleApplyReadiness {
  readonly canApply: boolean;
  readonly capabilityProfileChanged: boolean;
  readonly blockers: ReadonlyArray<string>;
  readonly providerInstancesToDisable: ReadonlyArray<string>;
}

interface EnvironmentBundleApplyContext {
  readonly providerInstances: ServerSettings["providerInstances"];
}

function environmentBundleApplicationStepLabel(
  current: EnvironmentBundle,
  incoming: EnvironmentBundle,
  component: ReturnType<typeof buildEnvironmentBundleApplicationPlan>[number]["component"],
  id: string,
): string {
  if (component === "skill") {
    const skill = [...incoming.skills, ...current.skills].find((entry) => entry.skillId === id);
    return `${component}:${skill?.name ?? id}`;
  }
  return `${component}:${id}`;
}

/**
 * Capability profiles already have a validated settings destination. Every
 * other bundle component stays fail-closed until its destination adapter,
 * credential resolution, and required health checks exist.
 */
export function getEnvironmentBundleApplyReadiness(
  current: EnvironmentBundle,
  incoming: EnvironmentBundle,
  context?: EnvironmentBundleApplyContext,
): EnvironmentBundleApplyReadiness {
  const steps = buildEnvironmentBundleApplicationPlan(current, incoming);
  const diff = diffEnvironmentBundles(current, incoming);
  const capabilityProfileChanged =
    current.capabilityProfile.profileId !== incoming.capabilityProfile.profileId ||
    current.capabilityProfile.name !== incoming.capabilityProfile.name ||
    steps.some((step) => step.component === "capability");
  const localProviderInstances = context?.providerInstances as
    | Readonly<Record<string, ProviderInstanceConfig>>
    | undefined;
  const providerInstancesToDisable = diff.providers.changed
    .filter(({ before, after }) => {
      const { enabled: beforeEnabled, ...beforeMetadata } = before;
      const { enabled: afterEnabled, ...afterMetadata } = after;
      const local = localProviderInstances?.[after.instanceId];
      return (
        beforeEnabled &&
        !afterEnabled &&
        JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata) &&
        local?.driver === after.driver
      );
    })
    .map(({ after }) => after.instanceId);
  const providerDisableSet = new Set(providerInstancesToDisable);
  const blockers = steps
    .filter(
      (step) =>
        step.component !== "bundle" &&
        step.component !== "capability" &&
        !(step.component === "provider" && providerDisableSet.has(step.id)),
    )
    .map((step) => {
      if (step.component === "provider") {
        const changed = diff.providers.changed.find(({ after }) => after.instanceId === step.id);
        if (changed?.before.enabled === false && changed.after.enabled === true) {
          return `provider:${step.id} cannot be enabled before a provider health-check adapter is available`;
        }
      }
      return `${environmentBundleApplicationStepLabel(current, incoming, step.component, step.id)} requires an application adapter`;
    });

  const hasSupportedChanges = capabilityProfileChanged || providerInstancesToDisable.length > 0;
  if (!hasSupportedChanges && blockers.length === 0) {
    blockers.push("The bundle does not contain any supported changes to apply");
  }
  return {
    canApply: hasSupportedChanges && blockers.length === 0,
    capabilityProfileChanged,
    blockers,
    providerInstancesToDisable,
  };
}

export function buildEnvironmentBundleSettingsPatch(
  current: EnvironmentBundle,
  incoming: EnvironmentBundle,
  context: EnvironmentBundleApplyContext,
): ServerSettingsPatch {
  const readiness = getEnvironmentBundleApplyReadiness(current, incoming, context);
  if (!readiness.canApply) {
    throw new Error(`Environment Bundle cannot be applied: ${readiness.blockers.join("; ")}`);
  }
  const providerInstances = context.providerInstances as Readonly<
    Record<string, ProviderInstanceConfig>
  >;
  const nextProviderInstances: Record<string, ProviderInstanceConfig> = { ...providerInstances };
  for (const instanceId of readiness.providerInstancesToDisable) {
    const instance = providerInstances[instanceId];
    if (!instance) {
      throw new Error(`Environment Bundle provider settings not found: ${instanceId}`);
    }
    nextProviderInstances[instanceId] = { ...instance, enabled: false };
  }

  return {
    ...(readiness.capabilityProfileChanged
      ? { capabilityProfile: incoming.capabilityProfile }
      : {}),
    ...(readiness.providerInstancesToDisable.length > 0
      ? {
          providerInstances:
            nextProviderInstances as unknown as ServerSettings["providerInstances"],
        }
      : {}),
  };
}
