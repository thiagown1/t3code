/**
 * FirstMateRequestDecisionReactor - lifts a delegated thread's pending requests
 * into the FirstMate supervisor's decision inbox.
 *
 * A user running seven threads at once should not have to open each one to
 * find out which is waiting on them. When a thread FirstMate delegated a topic
 * to raises an approval or user-input request, this reactor opens a decision on
 * that project's FirstMate workspace, so the request shows up in the same
 * blocking-first feed as the decisions the supervisor asks itself.
 *
 * Each pass reconciles rather than reacts: it recomputes the thread's open
 * requests and makes the workspace match. That is what makes it idempotent
 * (a repeated pass re-derives the same decision id, which the decider rejects
 * as a duplicate) and what closes the loop when the user answers a request in
 * the thread itself (the request is no longer open, so its card is cancelled
 * and leaves the inbox).
 *
 * Scope is deliberately narrow. Only threads a FirstMate topic is delegated to
 * are projected, never the supervisor thread itself, and only requests
 * `firstMateRequestDecisions` can state exactly. Everything else stays pending
 * on its own thread.
 *
 * Dismissing a card with the inbox's Cancel button is therefore permanent for
 * that request: the decision id is derived from the request, so a later pass
 * sees it already exists and does not re-raise it. That is the intended way to
 * say "leave this one to me" without also answering it.
 *
 * @module FirstMateRequestDecisionReactor
 */
import {
  ApprovalRequestId,
  CommandId,
  ThreadId,
  type FirstMateDecision,
  type FirstMateWorkspaceState,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import {
  draftFirstMateRequestDecision,
  firstMateRequestDecisionId,
} from "./firstMateRequestDecisions.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "./Services/RuntimeReceiptBus.ts";
import { openRequests, THREAD_REQUEST_ACTIVITY_KINDS } from "./threadOpenRequests.ts";

export class FirstMateRequestDecisionReactor extends Context.Service<
  FirstMateRequestDecisionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/FirstMateRequestDecisionReactor") {}

const REQUEST_ACTIVITY_KINDS = new Set<string>(THREAD_REQUEST_ACTIVITY_KINDS);

export interface FirstMateRequestReconcileResult {
  readonly outcome: "reconciled" | "skipped";
  readonly openedRequestIds: ReadonlyArray<string>;
  readonly cancelledDecisionIds: ReadonlyArray<string>;
}

const SKIPPED: FirstMateRequestReconcileResult = {
  outcome: "skipped",
  openedRequestIds: [],
  cancelledDecisionIds: [],
};

/**
 * Threads whose request activity changed. The same event stream carries both
 * halves of the loop: a `*.requested` opens a card, a `*.resolved` in the
 * thread closes it.
 */
function reconcilableThreadId(event: OrchestrationEvent): ThreadId | null {
  if (event.type !== "thread.activity-appended") return null;
  return REQUEST_ACTIVITY_KINDS.has(event.payload.activity.kind) ? event.payload.threadId : null;
}

/** Pending cards this workspace already holds for requests on one thread. */
function pendingRequestDecisions(
  workspace: FirstMateWorkspaceState,
  threadId: ThreadId,
): ReadonlyArray<FirstMateDecision & { readonly requestId: ApprovalRequestId }> {
  return workspace.decisions.flatMap((decision) =>
    decision.status === "pending" &&
    decision.source.kind !== "firstmate" &&
    decision.source.threadId === threadId
      ? [{ ...decision, requestId: decision.source.requestId }]
      : [],
  );
}

/**
 * Make one thread's cards match its open requests.
 *
 * @internal Exported for tests.
 */
export const reconcileThreadRequestDecisions = Effect.fn("reconcileThreadRequestDecisions")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly engine: OrchestrationEngine.OrchestrationEngineShape;
    readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  }) {
    const { threadId, engine, snapshots } = input;

    // Excludes archived and deleted threads: work nobody can reach should not
    // be asking the user for anything.
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread)) return SKIPPED;

    const project = yield* snapshots.getProjectShellById(thread.value.projectId);
    if (Option.isNone(project)) return SKIPPED;
    const workspace = project.value.firstMate ?? null;
    if (workspace === null) return SKIPPED;
    // The supervisor's own requests belong to the supervisor. Projecting them
    // into its own inbox would make it a source of itself.
    if (workspace.supervisorThreadId === threadId) return SKIPPED;

    const topic = workspace.topics.find((entry) => entry.threadId === threadId);
    if (topic === undefined) return SKIPPED;

    const detail = yield* snapshots.getThreadDetailById(threadId, {
      activityKinds: THREAD_REQUEST_ACTIVITY_KINDS,
    });
    if (Option.isNone(detail)) return SKIPPED;
    const open = openRequests(detail.value);
    const existing = pendingRequestDecisions(workspace, threadId);
    // Any status, not just pending. A card the user dismissed from the inbox
    // must stay dismissed while its request is still open in the thread —
    // that is how "I will answer this one myself" is expressed.
    const known = new Set(workspace.decisions.map((decision) => decision.id as string));

    // One rejected command must not stall the rest of the pass: a card that
    // cannot be opened should not keep a stale card from being cancelled.
    const dispatchOrLog = (command: Parameters<typeof engine.dispatch>[0]) =>
      engine.dispatch(command).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("FirstMate request decision command was rejected", {
                threadId,
                commandType: command.type,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const openedRequestIds: string[] = [];
    for (const [requestId, activity] of open) {
      const decisionId = firstMateRequestDecisionId(threadId, ApprovalRequestId.make(requestId));
      if (known.has(decisionId)) continue;
      const draft = draftFirstMateRequestDecision({ threadId, activity });
      if (draft === null) continue;
      const opened = yield* dispatchOrLog({
        type: "firstmate.decision.open",
        commandId: CommandId.make(`server:firstmate-request-open:${decisionId}`),
        projectId: project.value.id,
        createdAt,
        decisionId,
        topicId: topic.id,
        source: draft.source,
        question: draft.question,
        options: draft.options,
        // Never nudge the user toward authorizing something. The provider's
        // opinion about a safe default is not the supervisor's to relay.
        recommendedOptionId: null,
        // A provider waiting on an answer is the definition of blocked.
        blocking: true,
      });
      if (opened) openedRequestIds.push(requestId);
    }

    const cancelledDecisionIds: string[] = [];
    for (const decision of existing) {
      if (open.has(decision.requestId as string)) continue;
      const cancelled = yield* dispatchOrLog({
        type: "firstmate.decision.cancel",
        commandId: CommandId.make(`server:firstmate-request-cancel:${decision.id}`),
        projectId: project.value.id,
        createdAt,
        decisionId: decision.id,
      });
      if (cancelled) cancelledDecisionIds.push(decision.id);
    }

    return {
      outcome: "reconciled",
      openedRequestIds,
      cancelledDecisionIds,
    } satisfies FirstMateRequestReconcileResult;
  },
);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const receiptBus = yield* RuntimeReceiptBus;

  const processThread = (threadId: ThreadId) =>
    reconcileThreadRequestDecisions({ threadId, engine, snapshots }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("FirstMate request decision reconcile failed", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
      ),
      Effect.flatMap((result) =>
        Effect.flatMap(DateTime.now, (now) =>
          receiptBus.publish({
            type: "firstmate.request-decision.settled",
            threadId,
            outcome: result === null ? "failed" : result.outcome,
            openedCount: result?.openedRequestIds.length ?? 0,
            cancelledCount: result?.cancelledDecisionIds.length ?? 0,
            createdAt: DateTime.formatIso(now),
          }),
        ),
      ),
    );

  const worker = yield* makeDrainableWorker(processThread);

  const start: FirstMateRequestDecisionReactor["Service"]["start"] = Effect.fn(
    "FirstMateRequestDecisionReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        const threadId = reconcilableThreadId(event);
        return threadId === null ? Effect.void : worker.enqueue(threadId);
      }),
    );
  });

  return { start, drain: worker.drain } satisfies FirstMateRequestDecisionReactor["Service"];
});

export const layer = Layer.effect(FirstMateRequestDecisionReactor, make);
