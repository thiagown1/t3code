import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PortableCapabilityProfile, PortableCredentialReference } from "./capabilityProfile.ts";

const StableId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const LogicalPath = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const ContentHash = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/i));

export const ENVIRONMENT_BUNDLE_KNOWN_ROOT_INSTRUCTION_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
] as const;
export const ENVIRONMENT_BUNDLE_KNOWN_ROOT_INSTRUCTION_SCOPE = {
  id: "known-root-v1",
  hash: "637fc2066cbccda761bec5b6ce4bc69ed23f8186b941b75cc5f4b3f5b3ae4c4f",
} as const;

export const EnvironmentBundleMcpServer = Schema.Struct({
  serverId: StableId,
  origin: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  configurationRef: StableId,
  configurationHash: Schema.optionalKey(ContentHash),
  credentialRefs: Schema.Array(PortableCredentialReference),
  allowedTools: Schema.Array(TrimmedNonEmptyString),
  blockedTools: Schema.Array(TrimmedNonEmptyString),
});
export type EnvironmentBundleMcpServer = typeof EnvironmentBundleMcpServer.Type;

export const EnvironmentBundleSkillOrigin = Schema.Literals([
  "local",
  "project",
  "provider",
  "plugin",
]);
export type EnvironmentBundleSkillOrigin = typeof EnvironmentBundleSkillOrigin.Type;

export const EnvironmentBundleSkill = Schema.Struct({
  skillId: StableId,
  name: TrimmedNonEmptyString,
  origin: EnvironmentBundleSkillOrigin,
  enabled: Schema.Boolean,
  logicalPath: Schema.optionalKey(LogicalPath),
  version: Schema.optionalKey(TrimmedNonEmptyString),
  contentHash: Schema.optionalKey(ContentHash),
  providedByPluginId: Schema.optionalKey(StableId),
});
export type EnvironmentBundleSkill = typeof EnvironmentBundleSkill.Type;

export const EnvironmentBundlePluginAppKind = Schema.Literals(["plugin", "app"]);
export type EnvironmentBundlePluginAppKind = typeof EnvironmentBundlePluginAppKind.Type;

export const EnvironmentBundlePluginApp = Schema.Struct({
  integrationId: StableId,
  kind: EnvironmentBundlePluginAppKind,
  enabled: Schema.Boolean,
  version: Schema.optionalKey(TrimmedNonEmptyString),
});
export type EnvironmentBundlePluginApp = typeof EnvironmentBundlePluginApp.Type;

export const EnvironmentBundleProvider = Schema.Struct({
  instanceId: StableId,
  driver: StableId,
  enabled: Schema.Boolean,
  version: Schema.optionalKey(TrimmedNonEmptyString),
  profileRef: Schema.optionalKey(StableId),
});
export type EnvironmentBundleProvider = typeof EnvironmentBundleProvider.Type;

export const EnvironmentBundleProjectInstruction = Schema.Struct({
  logicalPath: LogicalPath,
  contentHash: ContentHash,
  enabled: Schema.Boolean,
});
export type EnvironmentBundleProjectInstruction = typeof EnvironmentBundleProjectInstruction.Type;

export const EnvironmentBundleProjectInstructionsScope = Schema.Struct({
  id: Schema.Literal("known-root-v1"),
  hash: ContentHash,
});
export type EnvironmentBundleProjectInstructionsScope =
  typeof EnvironmentBundleProjectInstructionsScope.Type;

/**
 * A portable description of an environment's intended integrations.
 * It contains references and hashes, never executable configuration or secrets.
 */
export const EnvironmentBundle = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  bundleId: StableId,
  name: TrimmedNonEmptyString,
  capabilityProfile: PortableCapabilityProfile,
  mcpServers: Schema.Array(EnvironmentBundleMcpServer),
  skills: Schema.Array(EnvironmentBundleSkill),
  pluginsAndApps: Schema.Array(EnvironmentBundlePluginApp),
  providers: Schema.Array(EnvironmentBundleProvider),
  projectInstructions: Schema.Array(EnvironmentBundleProjectInstruction),
  projectInstructionsScope: Schema.optionalKey(EnvironmentBundleProjectInstructionsScope),
  initialSkillContextBudgetTokens: Schema.optionalKey(PositiveInt),
});
export type EnvironmentBundle = typeof EnvironmentBundle.Type;

export const EnvironmentBundleHealthStatus = Schema.Literals([
  "configured",
  "missing-credential",
  "unavailable",
  "disabled",
  "ready",
]);
export type EnvironmentBundleHealthStatus = typeof EnvironmentBundleHealthStatus.Type;

export const EnvironmentBundleCredentialResolutionStatus = Schema.Literals([
  "resolved",
  "missing",
  "unsupported",
]);
export type EnvironmentBundleCredentialResolutionStatus =
  typeof EnvironmentBundleCredentialResolutionStatus.Type;

export const EnvironmentBundleCredentialResolution = Schema.Struct({
  credentialRef: PortableCredentialReference,
  status: EnvironmentBundleCredentialResolutionStatus,
});
export type EnvironmentBundleCredentialResolution =
  typeof EnvironmentBundleCredentialResolution.Type;

export const EnvironmentBundleCredentialResolutions = Schema.Array(
  EnvironmentBundleCredentialResolution,
);
export type EnvironmentBundleCredentialResolutions =
  typeof EnvironmentBundleCredentialResolutions.Type;

export const EnvironmentBundleInventoryCoverage = Schema.Literals([
  "complete",
  "partial",
  "unavailable",
]);
export type EnvironmentBundleInventoryCoverage = typeof EnvironmentBundleInventoryCoverage.Type;

export const EnvironmentBundleProjectInstructionScopeReason = Schema.Struct({
  logicalPath: Schema.Literals(ENVIRONMENT_BUNDLE_KNOWN_ROOT_INSTRUCTION_PATHS),
  code: Schema.Literals([
    "outside-root",
    "not-regular-file",
    "oversized",
    "size-changed",
    "changed-during-scan",
    "io-error",
  ]),
});
export type EnvironmentBundleProjectInstructionScopeReason =
  typeof EnvironmentBundleProjectInstructionScopeReason.Type;

/**
 * Secret-free inventory produced by the environment server. Coverage is
 * explicit because provider-native MCP and instruction sources are not all
 * observable without starting a session or reading unsafe raw config.
 */
export const EnvironmentBundleServerInventory = Schema.Struct({
  mcpServers: Schema.Array(EnvironmentBundleMcpServer),
  mcpCoverage: EnvironmentBundleInventoryCoverage,
  projectInstructions: Schema.Array(EnvironmentBundleProjectInstruction),
  projectInstructionsCoverage: EnvironmentBundleInventoryCoverage,
  projectInstructionsScope: Schema.optionalKey(EnvironmentBundleProjectInstructionsScope),
  // Optional for compatibility with ServerConfig payloads from older servers.
  // Consumers must not infer attestation from their absence.
  projectInstructionsScopeCoverage: Schema.optionalKey(EnvironmentBundleInventoryCoverage),
  projectInstructionsScopeReasons: Schema.optionalKey(
    Schema.Array(EnvironmentBundleProjectInstructionScopeReason),
  ),
});
export type EnvironmentBundleServerInventory = typeof EnvironmentBundleServerInventory.Type;

const EnvironmentBundleClaudeSkillDisableOperation = Schema.Struct({
  component: Schema.Literal("skill"),
  operation: Schema.Literal("disable"),
  adapter: Schema.Literal("claude-project-skill-override"),
  skillName: StableId,
  targetIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  providerInstanceIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  requiresProviderReload: Schema.Literal(true),
});
const EnvironmentBundleCodexSkillDisableOperation = Schema.Struct({
  component: Schema.Literal("skill"),
  operation: Schema.Literal("disable"),
  adapter: Schema.Literal("codex-project-skill-override"),
  skillName: StableId,
  targetIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  providerInstanceIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  requiresProviderReload: Schema.Literal(true),
});
const EnvironmentBundleCodexPluginAppDisableOperation = Schema.Struct({
  component: Schema.Literal("plugin-app"),
  operation: Schema.Literal("disable"),
  adapter: Schema.Literal("codex-project-plugin-skills-override"),
  integrationId: StableId,
  kind: EnvironmentBundlePluginAppKind,
  targetIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  providerInstanceIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  requiresProviderReload: Schema.Literal(true),
});
const EnvironmentBundleClaudeMcpDisableOperation = Schema.Struct({
  component: Schema.Literal("mcp"),
  operation: Schema.Literal("disable"),
  adapter: Schema.Literal("claude-project-mcp-override"),
  serverName: StableId,
  targetIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  providerInstanceIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  requiresProviderReload: Schema.Literal(true),
});
const EnvironmentBundleOpenCodeMcpDisableOperation = Schema.Struct({
  component: Schema.Literal("mcp"),
  operation: Schema.Literal("disable"),
  adapter: Schema.Literal("opencode-project-mcp-override"),
  serverName: StableId,
  targetIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  providerInstanceIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  requiresProviderReload: Schema.Literal(true),
});
const EnvironmentBundleProviderEnableOperation = Schema.Struct({
  component: Schema.Literal("provider"),
  operation: Schema.Literal("enable"),
  adapter: Schema.Literal("provider-settings-enable"),
  instanceId: StableId,
  driver: StableId,
  settingsTarget: Schema.Literals(["legacy", "instance"]),
  providerInstanceIds: Schema.Array(StableId).check(Schema.isMinLength(1)),
  requiresProviderReload: Schema.Literal(true),
  healthCheckRequired: Schema.Literal(true),
});
export const EnvironmentBundleApplyOperation = Schema.Union([
  EnvironmentBundleClaudeSkillDisableOperation,
  EnvironmentBundleCodexSkillDisableOperation,
  EnvironmentBundleCodexPluginAppDisableOperation,
  EnvironmentBundleClaudeMcpDisableOperation,
  EnvironmentBundleOpenCodeMcpDisableOperation,
  EnvironmentBundleProviderEnableOperation,
]);
export type EnvironmentBundleApplyOperation = typeof EnvironmentBundleApplyOperation.Type;

/**
 * Authoritative, secret-free plan produced immediately before an Environment
 * Bundle mutation. `targetStateHash` binds confirmation to the exact local
 * destination contents without exposing those contents or their path.
 */
export const EnvironmentBundleApplyPlan = Schema.Struct({
  bundleId: StableId,
  canApply: Schema.Boolean,
  operations: Schema.Array(EnvironmentBundleApplyOperation),
  blockers: Schema.Array(TrimmedNonEmptyString),
  targetStateHash: ContentHash,
});
export type EnvironmentBundleApplyPlan = typeof EnvironmentBundleApplyPlan.Type;

export const EnvironmentBundleApplyPlanInput = Schema.Struct({
  current: EnvironmentBundle,
  incoming: EnvironmentBundle,
});
export type EnvironmentBundleApplyPlanInput = typeof EnvironmentBundleApplyPlanInput.Type;

export const EnvironmentBundleApplyInput = Schema.Struct({
  current: EnvironmentBundle,
  incoming: EnvironmentBundle,
  expectedPlan: EnvironmentBundleApplyPlan,
});
export type EnvironmentBundleApplyInput = typeof EnvironmentBundleApplyInput.Type;

export const EnvironmentBundleApplyResult = Schema.Struct({
  bundleId: StableId,
  appliedOperations: Schema.Array(EnvironmentBundleApplyOperation),
  refreshedProviderInstanceIds: Schema.Array(StableId),
});
export type EnvironmentBundleApplyResult = typeof EnvironmentBundleApplyResult.Type;

export const EnvironmentBundleApplyErrorReason = Schema.Literals([
  "snapshot-failed",
  "plan-changed",
  "blocked",
  "persistence-failed",
  "health-check-failed",
  "rollback-failed",
]);
export type EnvironmentBundleApplyErrorReason = typeof EnvironmentBundleApplyErrorReason.Type;

export class EnvironmentBundleApplyError extends Schema.TaggedError<EnvironmentBundleApplyError>()(
  "EnvironmentBundleApplyError",
  {
    reason: EnvironmentBundleApplyErrorReason,
    message: TrimmedNonEmptyString,
  },
) {}
