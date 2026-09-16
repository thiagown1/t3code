import {
  defaultInstanceIdForDriver,
  type EnvironmentBundle,
  type EnvironmentBundleApplyPlan,
  type EnvironmentBundleCredentialResolutions,
  type EnvironmentBundleServerInventory,
  type PortableCapabilityProfile,
  type PortableCredentialReference,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ServerProviderSkill,
  type ServerProviderWorkspaceSnapshot,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { resolveProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
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

const CODEX_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
const LEGACY_PROVIDER_DRIVERS = new Set<keyof ServerSettings["providers"]>([
  "antigravity",
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
]);

function isLegacyProviderDriver(value: string): value is keyof ServerSettings["providers"] {
  return LEGACY_PROVIDER_DRIVERS.has(value as keyof ServerSettings["providers"]);
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
    case "plugin-app": {
      const pluginsAndApps = updateEnvironmentBundleEntry({
        values: bundle.pluginsAndApps,
        id: target.id,
        keyOf: (entry) => `${entry.kind}:${entry.integrationId}`,
        update: (entry) => ({ ...entry, enabled }),
        label: "plugin/app",
      });
      const integration = pluginsAndApps.find(
        (entry) => `${entry.kind}:${entry.integrationId}` === target.id,
      )!;
      return {
        ...bundle,
        pluginsAndApps,
        skills: bundle.skills.map((skill) =>
          skill.origin === "plugin" && skill.providedByPluginId === integration.integrationId
            ? { ...skill, enabled }
            : skill,
        ),
      };
    }
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

export function collectEnvironmentBundleCredentialReferences(
  bundle: EnvironmentBundle,
): ReadonlyArray<PortableCredentialReference> {
  const references = new Map<string, PortableCredentialReference>();
  for (const capability of bundle.capabilityProfile.capabilities) {
    if (!capability.credentialRef) continue;
    references.set(
      `${capability.credentialRef.kind}:${capability.credentialRef.id}`,
      capability.credentialRef,
    );
  }
  for (const server of bundle.mcpServers) {
    for (const credentialRef of server.credentialRefs) {
      references.set(`${credentialRef.kind}:${credentialRef.id}`, credentialRef);
    }
  }
  return [...references.values()].sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
  );
}

export function summarizeEnvironmentBundleCredentialResolutions(
  resolutions: EnvironmentBundleCredentialResolutions,
): { readonly resolved: number; readonly missing: number; readonly unsupported: number } {
  return resolutions.reduce(
    (summary, resolution) => ({
      ...summary,
      [resolution.status]: summary[resolution.status] + 1,
    }),
    { resolved: 0, missing: 0, unsupported: 0 },
  );
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
  readonly codexMcpServersToDisable: ReadonlyArray<{
    readonly serverId: string;
    readonly instanceId: string;
    readonly serverName: string;
  }>;
}

export type EnvironmentBundleApplyMode = "settings" | "authoritative" | "blocked";

export function environmentBundleApplyMode(
  settingsReadiness: Pick<EnvironmentBundleApplyReadiness, "canApply">,
  authoritativePlan: Pick<EnvironmentBundleApplyPlan, "canApply"> | null,
): EnvironmentBundleApplyMode {
  if (settingsReadiness.canApply) return "settings";
  if (authoritativePlan?.canApply === true) return "authoritative";
  return "blocked";
}

interface EnvironmentBundleApplyContext {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly providers?: ServerSettings["providers"];
  readonly credentialResolutions?: EnvironmentBundleCredentialResolutions;
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

function recordsEqualExceptEnablementAndHash(
  before: EnvironmentBundle["mcpServers"][number],
  after: EnvironmentBundle["mcpServers"][number],
): boolean {
  // The sanitized hash includes `enabled`, so a portable disable naturally has
  // a different hash. Disabling remains safe when every inspectable identity,
  // credential reference, and tool policy matches; opaque executable details
  // are preserved locally and never copied from the bundle.
  const {
    enabled: _beforeEnabled,
    configurationHash: _beforeConfigurationHash,
    ...beforeMetadata
  } = before;
  const {
    enabled: _afterEnabled,
    configurationHash: _afterConfigurationHash,
    ...afterMetadata
  } = after;
  return JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata);
}

function codexMcpDisableTarget(
  before: EnvironmentBundle["mcpServers"][number],
  after: EnvironmentBundle["mcpServers"][number],
  providerInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined,
  legacyProviders: ServerSettings["providers"] | undefined,
) {
  if (!before.enabled || after.enabled || !recordsEqualExceptEnablementAndHash(before, after)) {
    return null;
  }
  for (const [instanceId, instance] of Object.entries(providerInstances ?? {})) {
    const prefix = `codex:${instanceId}:`;
    if (instance.driver !== "codex" || !after.serverId.startsWith(prefix)) continue;
    const serverName = after.serverId.slice(prefix.length);
    if (
      !/^[A-Za-z0-9_.-]{1,256}$/u.test(serverName) ||
      /^sha256-[a-f0-9]{32}$/u.test(serverName) ||
      after.origin !== `codex:${instanceId}:effective-config` ||
      after.configurationRef !== `codex:${instanceId}:mcp:${serverName}`
    ) {
      return null;
    }
    return { serverId: after.serverId, instanceId, serverName } as const;
  }

  const defaultInstanceId = CODEX_DEFAULT_INSTANCE_ID;
  if (legacyProviders?.codex && !Object.hasOwn(providerInstances ?? {}, defaultInstanceId)) {
    const prefix = `codex:${defaultInstanceId}:`;
    const serverName = after.serverId.startsWith(prefix) ? after.serverId.slice(prefix.length) : "";
    if (
      /^[A-Za-z0-9_.-]{1,256}$/u.test(serverName) &&
      !/^sha256-[a-f0-9]{32}$/u.test(serverName) &&
      after.origin === `codex:${defaultInstanceId}:effective-config` &&
      after.configurationRef === `codex:${defaultInstanceId}:mcp:${serverName}`
    ) {
      return {
        serverId: after.serverId,
        instanceId: defaultInstanceId,
        serverName,
      } as const;
    }
  }
  return null;
}

function quoteCliToken(value: string): string {
  if (value.length > 0 && !/[\s'"\\]/u.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/["\\$`]/gu, "\\$&")}"`;
}

function appendCodexMcpDisableOverride(launchArgs: unknown, serverName: string): string {
  const tokens = [...tokenizeCliArgs(typeof launchArgs === "string" ? launchArgs : undefined)];
  tokens.push("-c", `mcp_servers.${serverName}.enabled=false`);
  return tokens.map(quoteCliToken).join(" ");
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
      const isLegacyDefault =
        !Object.hasOwn(localProviderInstances ?? {}, after.instanceId) &&
        after.instanceId === after.driver &&
        isLegacyProviderDriver(after.driver) &&
        context?.providers?.[after.driver] !== undefined;
      return (
        beforeEnabled &&
        !afterEnabled &&
        JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata) &&
        (local?.driver === after.driver || isLegacyDefault)
      );
    })
    .map(({ after }) => after.instanceId);
  const providerDisableSet = new Set(providerInstancesToDisable);
  const codexMcpServersToDisable = diff.mcpServers.changed.flatMap(({ before, after }) => {
    const target = codexMcpDisableTarget(before, after, localProviderInstances, context?.providers);
    return target === null ? [] : [target];
  });
  const codexMcpDisableSet = new Set(codexMcpServersToDisable.map(({ serverId }) => serverId));
  const blockers = steps
    .filter(
      (step) =>
        step.component !== "bundle" &&
        step.component !== "capability" &&
        !(step.component === "provider" && providerDisableSet.has(step.id)) &&
        !(step.component === "mcp-server" && codexMcpDisableSet.has(step.id)),
    )
    .map((step) => {
      if (step.component === "provider") {
        const changed = diff.providers.changed.find(({ after }) => after.instanceId === step.id);
        if (changed?.before.enabled === false && changed.after.enabled === true) {
          return `provider:${step.id} cannot be enabled before a provider health-check adapter is available`;
        }
      }
      if (step.component === "mcp-server") {
        const changed = diff.mcpServers.changed.find(({ after }) => after.serverId === step.id);
        if (changed?.before.enabled === false && changed.after.enabled === true) {
          return `mcp-server:${step.id} cannot be enabled before an MCP health-check adapter is available`;
        }
      }
      return `${environmentBundleApplicationStepLabel(current, incoming, step.component, step.id)} requires an application adapter`;
    });

  if (capabilityProfileChanged) {
    const resolutionByReference = new Map(
      (context?.credentialResolutions ?? []).map((resolution) => [
        `${resolution.credentialRef.kind}:${resolution.credentialRef.id}`,
        resolution.status,
      ]),
    );
    const requiredReferences = new Map<string, PortableCredentialReference>();
    for (const capability of incoming.capabilityProfile.capabilities) {
      if (capability.state !== "enabled" || !capability.credentialRef) continue;
      requiredReferences.set(
        `${capability.credentialRef.kind}:${capability.credentialRef.id}`,
        capability.credentialRef,
      );
    }
    for (const [key] of [...requiredReferences].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const status = resolutionByReference.get(key);
      if (status === "resolved") continue;
      blockers.push(
        status === "missing"
          ? `credential:${key} is missing`
          : status === "unsupported"
            ? `credential:${key} uses an unsupported resolver`
            : `credential:${key} has not been checked`,
      );
    }
  }

  const hasSupportedChanges =
    capabilityProfileChanged ||
    providerInstancesToDisable.length > 0 ||
    codexMcpServersToDisable.length > 0;
  if (!hasSupportedChanges && blockers.length === 0) {
    blockers.push("The bundle does not contain any supported changes to apply");
  }
  return {
    canApply: hasSupportedChanges && blockers.length === 0,
    capabilityProfileChanged,
    blockers,
    providerInstancesToDisable,
    codexMcpServersToDisable,
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
  let providerInstancesChanged = false;
  const legacyProviderPatch: Record<string, { enabled?: boolean; launchArgs?: string }> = {};
  let legacyCodexLaunchArgs = context.providers?.codex.launchArgs;
  for (const instanceId of readiness.providerInstancesToDisable) {
    const instance = providerInstances[instanceId];
    if (!instance) {
      const incomingProvider = incoming.providers.find(
        (provider) => provider.instanceId === instanceId,
      );
      if (
        !incomingProvider ||
        incomingProvider.instanceId !== incomingProvider.driver ||
        !isLegacyProviderDriver(incomingProvider.driver) ||
        context.providers?.[incomingProvider.driver] === undefined
      ) {
        throw new Error(`Environment Bundle provider settings not found: ${instanceId}`);
      }
      legacyProviderPatch[incomingProvider.driver] = { enabled: false };
      continue;
    }
    nextProviderInstances[instanceId] = { ...instance, enabled: false };
    providerInstancesChanged = true;
  }
  for (const target of readiness.codexMcpServersToDisable) {
    const instance = nextProviderInstances[target.instanceId];
    if (!instance && target.instanceId === CODEX_DEFAULT_INSTANCE_ID) {
      if (!context.providers?.codex) {
        throw new Error(`Environment Bundle Codex settings not found: ${target.instanceId}`);
      }
      legacyCodexLaunchArgs = appendCodexMcpDisableOverride(
        legacyCodexLaunchArgs,
        target.serverName,
      );
      legacyProviderPatch.codex = {
        ...legacyProviderPatch.codex,
        launchArgs: legacyCodexLaunchArgs,
      };
      continue;
    }
    if (!instance || instance.driver !== "codex") {
      throw new Error(`Environment Bundle Codex settings not found: ${target.instanceId}`);
    }
    const config =
      instance.config !== null &&
      typeof instance.config === "object" &&
      !Array.isArray(instance.config)
        ? (instance.config as Readonly<Record<string, unknown>>)
        : {};
    nextProviderInstances[target.instanceId] = {
      ...instance,
      config: {
        ...config,
        launchArgs: appendCodexMcpDisableOverride(config.launchArgs, target.serverName),
      },
    };
    providerInstancesChanged = true;
  }

  return {
    ...(readiness.capabilityProfileChanged
      ? { capabilityProfile: incoming.capabilityProfile }
      : {}),
    ...(providerInstancesChanged
      ? {
          providerInstances:
            nextProviderInstances as unknown as ServerSettings["providerInstances"],
        }
      : {}),
    ...(Object.keys(legacyProviderPatch).length > 0
      ? {
          providers: legacyProviderPatch as NonNullable<ServerSettingsPatch["providers"]>,
        }
      : {}),
  };
}
