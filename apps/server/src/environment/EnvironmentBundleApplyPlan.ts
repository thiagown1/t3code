import type {
  EnvironmentBundle,
  EnvironmentBundleApplyOperation,
  EnvironmentBundleApplyPlan,
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

function providerSkills(provider: ServerProvider, cwd: string): ReadonlyArray<ServerProviderSkill> {
  return (
    provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.skills ?? provider.skills
  );
}

function equalExceptEnabled(
  before: EnvironmentBundle["skills"][number],
  after: EnvironmentBundle["skills"][number],
): boolean {
  const { enabled: _beforeEnabled, ...beforeMetadata } = before;
  const { enabled: _afterEnabled, ...afterMetadata } = after;
  return JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata);
}

function unsupportedStepMessage(component: string, id: string): string {
  return `${component}:${id} requires an application adapter`;
}

export function buildEnvironmentBundleApplyPlan(input: {
  readonly current: EnvironmentBundle;
  readonly incoming: EnvironmentBundle;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cwd: string;
  readonly targetStateHash: string;
}): EnvironmentBundleApplyPlan {
  const diff = diffEnvironmentBundles(input.current, input.incoming);
  const steps = buildEnvironmentBundleApplicationPlan(input.current, input.incoming);
  const blockers = steps
    .filter((step) => step.component !== "bundle" && step.component !== "skill")
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
      const skill = providerSkills(provider, input.cwd).find(
        (candidate) =>
          candidate.enabled &&
          candidate.name === after.name &&
          `${provider.instanceId}:${skillOrigin(candidate)}:${candidate.name}` === after.skillId,
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
        : providerSkills(provider, input.cwd)
            .filter((skill) => skill.enabled && skill.name === after.name)
            .map((skill) => ({
              instanceId: provider.instanceId,
              targetId: `${provider.instanceId}:${skillOrigin(skill)}:${skill.name}`,
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

    operationByName.set(after.name, {
      component: "skill",
      operation: "disable",
      adapter: "claude-project-skill-override",
      skillName: after.name,
      targetIds: affected.map((candidate) => candidate.targetId).sort(),
      providerInstanceIds: [...new Set(affected.map((candidate) => candidate.instanceId))].sort(),
      requiresProviderReload: true,
    });
  }

  const operations = [...operationByName.values()].sort((left, right) =>
    left.skillName.localeCompare(right.skillName),
  );
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
