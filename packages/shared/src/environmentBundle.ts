import {
  EnvironmentBundle,
  type EnvironmentBundleHealthStatus,
  type EnvironmentBundle as EnvironmentBundleType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { diffCapabilityProfiles, normalizeCapabilityProfile } from "./capabilityProfile.ts";

const decodeEnvironmentBundle = Schema.decodeUnknownSync(EnvironmentBundle);

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function uniqueSorted(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].sort(compareText);
}

function assertPortableLogicalPath(path: string): void {
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`Environment Bundle path must be logical and relative: ${path}`);
  }
}

function assertUnique(values: ReadonlyArray<string>, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      throw new Error(`Environment Bundle contains duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export function normalizeEnvironmentBundle(bundle: EnvironmentBundleType): EnvironmentBundleType {
  for (const skill of bundle.skills) {
    if (skill.logicalPath) assertPortableLogicalPath(skill.logicalPath);
  }
  for (const instruction of bundle.projectInstructions) {
    assertPortableLogicalPath(instruction.logicalPath);
  }
  assertUnique(
    bundle.mcpServers.map((server) => server.serverId),
    "MCP server ID",
  );
  assertUnique(
    bundle.skills.map((skill) => skill.skillId),
    "skill ID",
  );
  assertUnique(
    bundle.pluginsAndApps.map((entry) => `${entry.kind}:${entry.integrationId}`),
    "plugin/app ID",
  );
  assertUnique(
    bundle.providers.map((provider) => provider.instanceId),
    "provider instance ID",
  );
  assertUnique(
    bundle.projectInstructions.map((instruction) => instruction.logicalPath),
    "project instruction path",
  );
  for (const server of bundle.mcpServers) {
    const blocked = new Set(server.blockedTools);
    const conflict = server.allowedTools.find((tool) => blocked.has(tool));
    if (conflict) {
      throw new Error(
        `Environment Bundle MCP tool cannot be both allowed and blocked: ${server.serverId}:${conflict}`,
      );
    }
  }

  return {
    schemaVersion: 1,
    bundleId: bundle.bundleId,
    name: bundle.name,
    capabilityProfile: normalizeCapabilityProfile(bundle.capabilityProfile),
    mcpServers: [...bundle.mcpServers]
      .map((server) => ({
        serverId: server.serverId,
        origin: server.origin,
        enabled: server.enabled,
        configurationRef: server.configurationRef,
        ...(server.configurationHash ? { configurationHash: server.configurationHash } : {}),
        credentialRefs: [...server.credentialRefs].sort((left, right) =>
          compareText(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`),
        ),
        allowedTools: uniqueSorted(server.allowedTools),
        blockedTools: uniqueSorted(server.blockedTools),
      }))
      .sort((left, right) => compareText(left.serverId, right.serverId)),
    skills: [...bundle.skills]
      .map((skill) => ({
        skillId: skill.skillId,
        name: skill.name,
        origin: skill.origin,
        enabled: skill.enabled,
        ...(skill.logicalPath ? { logicalPath: skill.logicalPath } : {}),
        ...(skill.version ? { version: skill.version } : {}),
        ...(skill.contentHash ? { contentHash: skill.contentHash } : {}),
        ...(skill.providedByPluginId ? { providedByPluginId: skill.providedByPluginId } : {}),
      }))
      .sort((left, right) => compareText(left.skillId, right.skillId)),
    pluginsAndApps: [...bundle.pluginsAndApps]
      .map((entry) => ({
        integrationId: entry.integrationId,
        kind: entry.kind,
        enabled: entry.enabled,
        ...(entry.version ? { version: entry.version } : {}),
      }))
      .sort((left, right) =>
        compareText(`${left.kind}:${left.integrationId}`, `${right.kind}:${right.integrationId}`),
      ),
    providers: [...bundle.providers]
      .map((provider) => ({
        instanceId: provider.instanceId,
        driver: provider.driver,
        enabled: provider.enabled,
        ...(provider.version ? { version: provider.version } : {}),
        ...(provider.profileRef ? { profileRef: provider.profileRef } : {}),
      }))
      .sort((left, right) => compareText(left.instanceId, right.instanceId)),
    projectInstructions: [...bundle.projectInstructions]
      .map((instruction) => ({
        logicalPath: instruction.logicalPath,
        contentHash: instruction.contentHash,
        enabled: instruction.enabled,
      }))
      .sort((left, right) => compareText(left.logicalPath, right.logicalPath)),
    ...(bundle.initialSkillContextBudgetTokens === undefined
      ? {}
      : { initialSkillContextBudgetTokens: bundle.initialSkillContextBudgetTokens }),
  };
}

export function serializeEnvironmentBundle(bundle: EnvironmentBundleType): string {
  return `${JSON.stringify(normalizeEnvironmentBundle(bundle), null, 2)}\n`;
}

export function parseEnvironmentBundleJson(json: string): EnvironmentBundleType {
  const decoded = decodeEnvironmentBundle(JSON.parse(json));
  return normalizeEnvironmentBundle(decoded);
}

export interface EnvironmentBundleInventoryDiff<Value> {
  readonly added: ReadonlyArray<Value>;
  readonly removed: ReadonlyArray<Value>;
  readonly changed: ReadonlyArray<{ readonly before: Value; readonly after: Value }>;
}

function diffInventory<Value>(
  current: ReadonlyArray<Value>,
  incoming: ReadonlyArray<Value>,
  keyOf: (value: Value) => string,
): EnvironmentBundleInventoryDiff<Value> {
  const currentById = new Map(current.map((value) => [keyOf(value), value]));
  const incomingById = new Map(incoming.map((value) => [keyOf(value), value]));
  const added: Value[] = [];
  const removed: Value[] = [];
  const changed: Array<{
    before: Value;
    after: Value;
  }> = [];

  for (const [id, after] of incomingById) {
    const before = currentById.get(id);
    if (!before) added.push(after);
    else if (JSON.stringify(before) !== JSON.stringify(after)) changed.push({ before, after });
  }
  for (const [id, before] of currentById) {
    if (!incomingById.has(id)) removed.push(before);
  }
  return { added, removed, changed };
}

export function diffEnvironmentBundles(
  currentBundle: EnvironmentBundleType,
  incomingBundle: EnvironmentBundleType,
) {
  const current = normalizeEnvironmentBundle(currentBundle);
  const incoming = normalizeEnvironmentBundle(incomingBundle);
  return {
    identityChanged: current.bundleId !== incoming.bundleId || current.name !== incoming.name,
    capabilityProfile: diffCapabilityProfiles(
      current.capabilityProfile,
      incoming.capabilityProfile,
    ),
    mcpServers: diffInventory(current.mcpServers, incoming.mcpServers, (entry) => entry.serverId),
    skills: diffInventory(current.skills, incoming.skills, (entry) => entry.skillId),
    pluginsAndApps: diffInventory(
      current.pluginsAndApps,
      incoming.pluginsAndApps,
      (entry) => `${entry.kind}:${entry.integrationId}`,
    ),
    providers: diffInventory(current.providers, incoming.providers, (entry) => entry.instanceId),
    projectInstructions: diffInventory(
      current.projectInstructions,
      incoming.projectInstructions,
      (entry) => entry.logicalPath,
    ),
    skillContextBudgetChanged:
      current.initialSkillContextBudgetTokens !== incoming.initialSkillContextBudgetTokens,
  };
}

export function resolveEnvironmentBundleHealth(input: {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly credentialsReady: boolean;
  readonly available: boolean;
  readonly healthCheckCompleted: boolean;
}): EnvironmentBundleHealthStatus {
  if (!input.enabled) return "disabled";
  if (!input.configured || !input.available) return "unavailable";
  if (!input.credentialsReady) return "missing-credential";
  if (!input.healthCheckCompleted) return "configured";
  return "ready";
}
