import {
  type EnvironmentBundle,
  type EnvironmentBundleServerInventory,
  type PortableCapabilityProfile,
  type ServerProviderSkill,
  type ServerProviderWorkspaceSnapshot,
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
