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
