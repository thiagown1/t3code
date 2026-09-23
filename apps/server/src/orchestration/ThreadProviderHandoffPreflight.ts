import { ProviderDriverKind } from "@t3tools/contracts";
import type {
  FirstMateDecision,
  OrchestrationProjectShell,
  ServerProvider,
  ThreadProviderHandoffEnvelope,
  ThreadProviderHandoffProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import {
  prepareThreadProviderHandoff,
  ThreadProviderHandoffPreparationError,
  type ThreadProviderHandoffPreparationInput,
} from "./ThreadProviderHandoffPreparation.ts";

export interface ThreadProviderHandoffPreflightServices {
  readonly snapshots: Pick<
    ProjectionSnapshotQueryShape,
    "getSnapshotSequence" | "getThreadDetailSnapshot" | "getProjectShellById"
  >;
  readonly turns: Pick<ProjectionTurnRepositoryShape, "getPendingTurnStartByThreadId">;
  readonly providers: Pick<ProviderRegistryShape, "getProviders">;
}

type PreflightInput = Pick<
  ThreadProviderHandoffPreparationInput,
  | "handoffId"
  | "threadId"
  | "target"
  | "reason"
  | "expectedSequence"
  | "expectedTurnId"
  | "expectedContextHash"
  | "createdAt"
>;

export function availableTarget(
  target: ThreadProviderHandoffProvider,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  const provider = providers.find((item) => item.instanceId === target.providerInstanceId);
  return (
    provider !== undefined &&
    provider.driver === target.driver &&
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.models.some(
      (model) => model.slug === target.model || model.aliases?.includes(target.model),
    )
  );
}

function decisionsForThread(
  project: OrchestrationProjectShell,
  threadId: PreflightInput["threadId"],
): ReadonlyArray<FirstMateDecision> {
  const firstMate = project.firstMate;
  if (!firstMate) return [];
  const topicIds = new Set(
    firstMate.topics.filter((topic) => topic.threadId === threadId).map((topic) => topic.id),
  );
  return firstMate.decisions.filter((decision) => topicIds.has(decision.topicId));
}

/**
 * Read one persisted revision without reserving an active handoff. The returned
 * envelope is a preflight result, not a lease: execution must recheck the
 * revision and target before touching either provider session.
 */
export const preflightThreadProviderHandoff = Effect.fn("preflightThreadProviderHandoff")(
  function* (input: PreflightInput, services: ThreadProviderHandoffPreflightServices) {
    const before = yield* services.snapshots.getSnapshotSequence();
    const detail = yield* services.snapshots.getThreadDetailSnapshot(input.threadId);
    if (Option.isNone(detail)) {
      return yield* Effect.fail(new ThreadProviderHandoffPreparationError("thread-mismatch"));
    }
    const thread = detail.value.thread;
    const projectResult = yield* services.snapshots.getProjectShellById(thread.projectId);
    if (Option.isNone(projectResult)) {
      return yield* Effect.fail(new ThreadProviderHandoffPreparationError("project-mismatch"));
    }
    const pendingResult = yield* services.turns.getPendingTurnStartByThreadId({
      threadId: input.threadId,
    });
    const providers = yield* services.providers.getProviders;
    const after = yield* services.snapshots.getSnapshotSequence();
    if (
      before.snapshotSequence !== detail.value.snapshotSequence ||
      after.snapshotSequence !== detail.value.snapshotSequence ||
      input.expectedSequence !== detail.value.snapshotSequence
    ) {
      return yield* Effect.fail(new ThreadProviderHandoffPreparationError("stale-sequence"));
    }
    if (!availableTarget(input.target, providers)) {
      return yield* Effect.fail(new ThreadProviderHandoffPreparationError("target-invalid"));
    }
    const sourceDriver = thread.session?.providerName;
    if (sourceDriver === null || sourceDriver === undefined) {
      return yield* Effect.fail(new ThreadProviderHandoffPreparationError("session-unknown"));
    }
    const source: ThreadProviderHandoffProvider = {
      providerInstanceId: thread.modelSelection.instanceId,
      driver: ProviderDriverKind.make(sourceDriver),
      model: thread.modelSelection.model,
    };
    const envelope: ThreadProviderHandoffEnvelope = yield* Effect.try({
      try: () =>
        prepareThreadProviderHandoff(
          { ...input, source },
          {
            snapshotSequence: detail.value.snapshotSequence,
            thread,
            project: projectResult.value,
            decisions: decisionsForThread(projectResult.value, input.threadId),
            pendingTurnStart: Option.getOrNull(pendingResult),
            availableTargets: [input.target],
            availableTargetsAttestation: {
              version: 1,
              snapshotSequence: detail.value.snapshotSequence,
            },
          },
        ),
      catch: (cause) =>
        cause instanceof ThreadProviderHandoffPreparationError
          ? cause
          : new ThreadProviderHandoffPreparationError("invalid-context"),
    });
    return envelope;
  },
);
