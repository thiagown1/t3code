import {
  EnvironmentBundleApplyError,
  type EnvironmentBundle,
  type EnvironmentBundleApplyOperation,
  type EnvironmentBundleApplyPlan,
  type EnvironmentBundleApplyResult,
  type EnvironmentBundleServerInventory,
  ProviderInstanceId,
  type ServerSettingsError,
  type ServerSettings,
  type ServerSettingsPatch,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  loadClaudeSkillOverrideTargetState,
  rollbackClaudeSkillDisableOverrides,
  writeClaudeSkillDisableOverrides,
} from "./ClaudeSkillOverrideTarget.ts";
import {
  loadCodexSkillOverrideTargetState,
  rollbackCodexSkillDisableOverrides,
  writeCodexSkillDisableOverrides,
} from "./CodexSkillOverrideTarget.ts";
import {
  areEnvironmentBundleApplyOperationsEffective,
  buildEnvironmentBundleApplyPlan,
  environmentBundleProviderSkillId,
  environmentBundleProviderSkills,
} from "./EnvironmentBundleApplyPlan.ts";
import {
  canRollbackProviderEnables,
  providerEnablePatch,
  providerEnableTargetStateHash,
} from "./EnvironmentBundleProviderEnableTarget.ts";
import {
  loadOpenCodeMcpOverrideTargetState,
  rollbackOpenCodeMcpDisableOverrides,
  writeOpenCodeMcpDisableOverrides,
} from "./OpenCodeMcpOverrideTarget.ts";

const EMPTY_TARGET_STATE_HASH = "0".repeat(64);

type ProviderEnableOperation = Extract<
  EnvironmentBundleApplyOperation,
  { readonly adapter: "provider-settings-enable" }
>;

function providerEnableOperations(
  operations: ReadonlyArray<EnvironmentBundleApplyOperation>,
): ReadonlyArray<ProviderEnableOperation> {
  return operations.filter(
    (operation): operation is ProviderEnableOperation =>
      operation.adapter === "provider-settings-enable",
  );
}

function codexSkillPaths(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cwd: string;
  readonly operations: ReadonlyArray<EnvironmentBundleApplyOperation>;
}): ReadonlyArray<string> {
  const targetIds = new Set(
    input.operations.flatMap((operation) =>
      operation.adapter === "codex-project-skill-override" ||
      operation.adapter === "codex-project-plugin-skills-override"
        ? operation.targetIds
        : [],
    ),
  );
  const paths = input.providers.flatMap((provider) =>
    provider.driver !== "codex"
      ? []
      : environmentBundleProviderSkills(provider, input.cwd).flatMap((skill) =>
          targetIds.has(environmentBundleProviderSkillId(provider, skill)) ? [skill.path] : [],
        ),
  );
  return [...new Set(paths)].sort();
}

function applyError(
  reason: EnvironmentBundleApplyError["reason"],
  message: string,
): EnvironmentBundleApplyError {
  return new EnvironmentBundleApplyError({ reason, message });
}

export function environmentBundleApplyPlansMatch(
  expected: EnvironmentBundleApplyPlan,
  current: EnvironmentBundleApplyPlan,
): boolean {
  return JSON.stringify(expected) === JSON.stringify(current);
}

export const planEnvironmentBundleApply = Effect.fn("planEnvironmentBundleApply")(
  function* (input: {
    readonly current: EnvironmentBundle;
    readonly incoming: EnvironmentBundle;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly serverInventory: EnvironmentBundleServerInventory;
    readonly settings?: ServerSettings;
    readonly cwd: string;
  }) {
    const draft = buildEnvironmentBundleApplyPlan({
      ...input,
      targetStateHash: EMPTY_TARGET_STATE_HASH,
    });
    if (draft.blockers.length > 0 || draft.operations.length === 0) return draft;
    const providerOperations = providerEnableOperations(draft.operations);
    if (providerOperations.length === draft.operations.length) {
      if (!input.settings) {
        return {
          ...draft,
          canApply: false,
          blockers: ["Provider settings could not be inspected for the Environment Bundle dry run"],
        };
      }
      return buildEnvironmentBundleApplyPlan({
        ...input,
        targetStateHash: providerEnableTargetStateHash(input.settings, providerOperations),
      });
    }
    const usesOpenCodeTarget = draft.operations.every(
      (operation) => operation.adapter === "opencode-project-mcp-override",
    );
    const usesCodexSkillTarget = draft.operations.every(
      (operation) =>
        operation.adapter === "codex-project-skill-override" ||
        operation.adapter === "codex-project-plugin-skills-override",
    );
    const target = usesCodexSkillTarget
      ? yield* loadCodexSkillOverrideTargetState(input.cwd).pipe(
          Effect.mapError(() =>
            applyError(
              "snapshot-failed",
              "Codex project configuration could not be inspected for the Environment Bundle dry run",
            ),
          ),
        )
      : usesOpenCodeTarget
        ? yield* loadOpenCodeMcpOverrideTargetState(input.cwd).pipe(
            Effect.mapError(() =>
              applyError(
                "snapshot-failed",
                "OpenCode project configuration could not be inspected for the Environment Bundle dry run",
              ),
            ),
          )
        : yield* loadClaudeSkillOverrideTargetState(input.cwd).pipe(
            Effect.mapError(() =>
              applyError(
                "snapshot-failed",
                "Claude project settings could not be inspected for the Environment Bundle dry run",
              ),
            ),
          );
    return buildEnvironmentBundleApplyPlan({ ...input, targetStateHash: target.stateHash });
  },
);

export const applyEnvironmentBundle = Effect.fn("applyEnvironmentBundle")(function* (input: {
  readonly current: EnvironmentBundle;
  readonly incoming: EnvironmentBundle;
  readonly expectedPlan: EnvironmentBundleApplyPlan;
  readonly cwd: string;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly getSettings?: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly updateSettings?: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly getServerInventory: Effect.Effect<
    EnvironmentBundleServerInventory,
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly refreshWorkspaceSnapshot: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly force?: boolean;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refreshProviderInstance?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
}): Effect.fn.Return<
  EnvironmentBundleApplyResult,
  EnvironmentBundleApplyError,
  FileSystem.FileSystem | Path.Path
> {
  const providers = yield* input.getProviders.pipe(
    Effect.mapError(() =>
      applyError(
        "snapshot-failed",
        "Provider snapshots could not be read for Environment Bundle apply",
      ),
    ),
  );
  const serverInventory = yield* input.getServerInventory.pipe(
    Effect.mapError(() =>
      applyError("snapshot-failed", "Environment Bundle inventory could not be refreshed"),
    ),
  );
  const settings = input.getSettings
    ? yield* input.getSettings.pipe(
        Effect.mapError(() =>
          applyError(
            "snapshot-failed",
            "Provider settings could not be read for Environment Bundle apply",
          ),
        ),
      )
    : undefined;
  const currentPlan = yield* planEnvironmentBundleApply({
    current: input.current,
    incoming: input.incoming,
    providers,
    serverInventory,
    ...(settings ? { settings } : {}),
    cwd: input.cwd,
  });
  if (!environmentBundleApplyPlansMatch(input.expectedPlan, currentPlan)) {
    return yield* applyError(
      "plan-changed",
      "Environment Bundle apply plan changed; generate a new dry run",
    );
  }
  if (!currentPlan.canApply) {
    return yield* applyError(
      "blocked",
      currentPlan.blockers[0] ?? "Environment Bundle apply is blocked",
    );
  }

  const providerOperations = providerEnableOperations(currentPlan.operations);
  if (providerOperations.length === currentPlan.operations.length) {
    if (
      !settings ||
      !input.getSettings ||
      !input.updateSettings ||
      !input.refreshProviderInstance
    ) {
      return yield* applyError(
        "blocked",
        "Provider enable requires settings persistence and provider health-check adapters",
      );
    }
    const writtenSettings = yield* input
      .updateSettings(providerEnablePatch(providerOperations, true))
      .pipe(
        Effect.mapError(() =>
          applyError("persistence-failed", "Provider settings could not be enabled"),
        ),
      );
    const providerInstanceIds = providerOperations.map((operation) =>
      ProviderInstanceId.make(operation.instanceId),
    );
    const refreshResult = yield* Effect.exit(
      Effect.forEach(providerInstanceIds, input.refreshProviderInstance, { concurrency: 1 }),
    );
    const refreshedProviders = Exit.isSuccess(refreshResult)
      ? (refreshResult.value.at(-1) ?? providers)
      : providers;
    if (
      Exit.isSuccess(refreshResult) &&
      areEnvironmentBundleApplyOperationsEffective({
        providers: refreshedProviders,
        serverInventory,
        cwd: input.cwd,
        operations: currentPlan.operations,
      })
    ) {
      return {
        bundleId: input.incoming.bundleId,
        appliedOperations: currentPlan.operations,
        refreshedProviderInstanceIds: providerInstanceIds,
      };
    }

    const rollbackSettings = yield* input.getSettings.pipe(
      Effect.mapError(() =>
        applyError(
          "rollback-failed",
          "Provider health check failed and current settings could not be inspected for rollback",
        ),
      ),
    );
    if (
      !canRollbackProviderEnables({
        current: rollbackSettings,
        written: writtenSettings,
        operations: providerOperations,
      })
    ) {
      return yield* applyError(
        "rollback-failed",
        "Provider health check failed and provider settings changed before rollback",
      );
    }
    yield* input
      .updateSettings(providerEnablePatch(providerOperations, false))
      .pipe(
        Effect.mapError(() =>
          applyError(
            "rollback-failed",
            "Provider health check failed and the previous disabled state could not be restored",
          ),
        ),
      );
    yield* Effect.forEach(providerInstanceIds, input.refreshProviderInstance, {
      concurrency: 1,
    }).pipe(Effect.ignore);
    return yield* applyError(
      "health-check-failed",
      "Provider did not become ready after enablement; settings were rolled back",
    );
  }

  const usesOpenCodeTarget = currentPlan.operations.every(
    (operation) => operation.adapter === "opencode-project-mcp-override",
  );
  const usesCodexSkillTarget = currentPlan.operations.every(
    (operation) =>
      operation.adapter === "codex-project-skill-override" ||
      operation.adapter === "codex-project-plugin-skills-override",
  );
  let rollbackEffect: Effect.Effect<
    void,
    EnvironmentBundleApplyError,
    FileSystem.FileSystem | Path.Path
  >;
  if (usesCodexSkillTarget) {
    const skillPaths = codexSkillPaths({
      providers,
      cwd: input.cwd,
      operations: currentPlan.operations,
    });
    const written = yield* writeCodexSkillDisableOverrides({
      cwd: input.cwd,
      expectedStateHash: currentPlan.targetStateHash,
      skillPaths,
    }).pipe(
      Effect.mapError((cause) =>
        applyError(
          cause.reason === "state-changed" ? "plan-changed" : "persistence-failed",
          cause.message,
        ),
      ),
    );
    rollbackEffect = rollbackCodexSkillDisableOverrides({
      cwd: input.cwd,
      expectedWrittenStateHash: written.written.stateHash,
      previous: written.previous,
    }).pipe(Effect.mapError((cause) => applyError("rollback-failed", cause.message)));
  } else if (usesOpenCodeTarget) {
    const written = yield* writeOpenCodeMcpDisableOverrides({
      cwd: input.cwd,
      expectedStateHash: currentPlan.targetStateHash,
      serverNames: currentPlan.operations.flatMap((operation) =>
        operation.adapter === "opencode-project-mcp-override" ? [operation.serverName] : [],
      ),
    }).pipe(
      Effect.mapError((cause) =>
        applyError(
          cause.reason === "state-changed" ? "plan-changed" : "persistence-failed",
          cause.message,
        ),
      ),
    );
    rollbackEffect = rollbackOpenCodeMcpDisableOverrides({
      cwd: input.cwd,
      expectedWrittenStateHash: written.written.stateHash,
      previous: written.previous,
    }).pipe(Effect.mapError((cause) => applyError("rollback-failed", cause.message)));
  } else {
    const written = yield* writeClaudeSkillDisableOverrides({
      cwd: input.cwd,
      expectedStateHash: currentPlan.targetStateHash,
      skillNames: currentPlan.operations.flatMap((operation) =>
        operation.component === "skill" ? [operation.skillName] : [],
      ),
      mcpServerNames: currentPlan.operations.flatMap((operation) =>
        operation.adapter === "claude-project-mcp-override" ? [operation.serverName] : [],
      ),
    }).pipe(
      Effect.mapError((cause) =>
        applyError(
          cause.reason === "state-changed" ? "plan-changed" : "persistence-failed",
          cause.message,
        ),
      ),
    );
    rollbackEffect = rollbackClaudeSkillDisableOverrides({
      cwd: input.cwd,
      expectedWrittenStateHash: written.written.stateHash,
      previous: written.previous,
    }).pipe(Effect.mapError((cause) => applyError("rollback-failed", cause.message)));
  }
  const providerInstanceIds = [
    ...new Set(currentPlan.operations.flatMap((operation) => operation.providerInstanceIds)),
  ]
    .sort()
    .map((instanceId) => ProviderInstanceId.make(instanceId));
  let refreshedProviders = providers;
  const refreshResult = yield* Effect.exit(
    Effect.forEach(
      providerInstanceIds,
      (instanceId) => input.refreshWorkspaceSnapshot({ instanceId, cwd: input.cwd, force: true }),
      { concurrency: 1 },
    ),
  );
  if (Exit.isSuccess(refreshResult) && refreshResult.value.length > 0) {
    refreshedProviders = refreshResult.value.at(-1)!;
  }
  const refreshedInventory = yield* input.getServerInventory.pipe(
    Effect.orElseSucceed(() => serverInventory),
  );
  const effective =
    Exit.isSuccess(refreshResult) &&
    areEnvironmentBundleApplyOperationsEffective({
      providers: refreshedProviders,
      serverInventory: refreshedInventory,
      cwd: input.cwd,
      operations: currentPlan.operations,
    });
  if (!effective) {
    const rollback = yield* Effect.exit(rollbackEffect);
    if (Exit.isFailure(rollback)) {
      return yield* applyError(
        "rollback-failed",
        "Project configuration disable did not become effective and the previous settings could not be restored safely",
      );
    }
    yield* Effect.forEach(
      providerInstanceIds,
      (instanceId) => input.refreshWorkspaceSnapshot({ instanceId, cwd: input.cwd, force: true }),
      { concurrency: 1 },
    ).pipe(Effect.ignore);
    return yield* applyError(
      "health-check-failed",
      "Project configuration disable did not become effective after provider refresh; settings were rolled back",
    );
  }

  return {
    bundleId: input.incoming.bundleId,
    appliedOperations: currentPlan.operations,
    refreshedProviderInstanceIds: providerInstanceIds,
  };
});
