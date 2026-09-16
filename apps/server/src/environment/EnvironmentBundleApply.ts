import {
  EnvironmentBundleApplyError,
  type EnvironmentBundle,
  type EnvironmentBundleApplyPlan,
  type EnvironmentBundleApplyResult,
  ProviderInstanceId,
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
  areClaudeSkillDisableOperationsEffective,
  buildEnvironmentBundleApplyPlan,
} from "./EnvironmentBundleApplyPlan.ts";

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
    readonly cwd: string;
  }) {
    const target = yield* loadClaudeSkillOverrideTargetState(input.cwd).pipe(
      Effect.mapError(() =>
        applyError(
          "snapshot-failed",
          "Claude project settings could not be inspected for the Environment Bundle dry run",
        ),
      ),
    );
    return buildEnvironmentBundleApplyPlan({
      ...input,
      targetStateHash: target.stateHash,
    });
  },
);

export const applyEnvironmentBundle = Effect.fn("applyEnvironmentBundle")(function* (input: {
  readonly current: EnvironmentBundle;
  readonly incoming: EnvironmentBundle;
  readonly expectedPlan: EnvironmentBundleApplyPlan;
  readonly cwd: string;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refreshWorkspaceSnapshot: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly force?: boolean;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;
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
  const currentPlan = yield* planEnvironmentBundleApply({
    current: input.current,
    incoming: input.incoming,
    providers,
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

  const written = yield* writeClaudeSkillDisableOverrides({
    cwd: input.cwd,
    expectedStateHash: currentPlan.targetStateHash,
    skillNames: currentPlan.operations.map((operation) => operation.skillName),
  }).pipe(
    Effect.mapError((cause) =>
      applyError(
        cause.reason === "state-changed" ? "plan-changed" : "persistence-failed",
        cause.message,
      ),
    ),
  );
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
  const effective =
    Exit.isSuccess(refreshResult) &&
    areClaudeSkillDisableOperationsEffective({
      providers: refreshedProviders,
      cwd: input.cwd,
      operations: currentPlan.operations,
    });
  if (!effective) {
    const rollback = yield* Effect.exit(
      rollbackClaudeSkillDisableOverrides({
        cwd: input.cwd,
        expectedWrittenStateHash: written.written.stateHash,
        previous: written.previous,
      }),
    );
    if (Exit.isFailure(rollback)) {
      return yield* applyError(
        "rollback-failed",
        "Claude skill disable did not become effective and the previous settings could not be restored safely",
      );
    }
    yield* Effect.forEach(
      providerInstanceIds,
      (instanceId) => input.refreshWorkspaceSnapshot({ instanceId, cwd: input.cwd, force: true }),
      { concurrency: 1 },
    ).pipe(Effect.ignore);
    return yield* applyError(
      "health-check-failed",
      "Claude skill disable did not become effective after provider refresh; settings were rolled back",
    );
  }

  return {
    bundleId: input.incoming.bundleId,
    appliedOperations: currentPlan.operations,
    refreshedProviderInstanceIds: providerInstanceIds,
  };
});
