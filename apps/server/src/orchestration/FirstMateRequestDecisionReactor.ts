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
 * Two things start a pass: request activity on a thread, and delegation. The
 * second matters because delegation moves the boundary of what is projected at
 * all — a thread can already be blocked on the user when its topic arrives, and
 * a topic moved to another thread leaves the old thread's cards pointing at
 * work the supervisor no longer owns.
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
  type OrchestrationThreadActivity,
  type ProjectId,
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

type OpenRequests = ReadonlyMap<string, OrchestrationThreadActivity>;

/** What a thread nothing is delegated to is treated as having open. */
const NO_OPEN_REQUESTS: OpenRequests = new Map();

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
 * What one event asks this reactor to re-check.
 *
 * `thread` is the steady-state trigger, and the same event stream carries both
 * halves of that loop: a `*.requested` opens a card, a `*.resolved` in the
 * thread closes it. `delegation` is the trigger for the boundary moving, where
 * the threads to re-check are not all named by the event.
 */
type ReconcileTask =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | {
      readonly kind: "delegation";
      readonly projectId: ProjectId;
      readonly threadId: ThreadId | null;
    };

function reconcileTaskForEvent(event: OrchestrationEvent): ReconcileTask | null {
  if (event.type === "thread.activity-appended") {
    return REQUEST_ACTIVITY_KINDS.has(event.payload.activity.kind)
      ? { kind: "thread", threadId: event.payload.threadId }
      : null;
  }
  if (
    event.type === "firstmate.domain-event" &&
    event.payload.type === "firstmate.topic-delegated"
  ) {
    return {
      kind: "delegation",
      projectId: event.payload.projectId,
      threadId: event.payload.threadId,
    };
  }
  return null;
}

/**
 * Threads a delegation change has to re-check: the thread the topic just moved
 * to, plus every thread this workspace still holds a pending card for.
 *
 * The event names only the new thread, so the thread a topic just left is found
 * from the workspace instead. Re-checking a thread that is still delegated is a
 * no-op by construction, which is cheaper than teaching the event to carry the
 * delegation it replaced.
 */
function delegationReconcileThreadIds(input: {
  readonly workspace: FirstMateWorkspaceState | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<ThreadId> {
  const threadIds = new Set<ThreadId>(input.threadId === null ? [] : [input.threadId]);
  for (const decision of input.workspace?.decisions ?? []) {
    if (decision.status !== "pending") continue;
    if (decision.source.kind === "firstmate") continue;
    if (decision.source.threadId === null) continue;
    threadIds.add(decision.source.threadId);
  }
  return [...threadIds];
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

    const topic = workspace.topics.find((entry) => entry.threadId === threadId) ?? null;
    const existing = pendingRequestDecisions(workspace, threadId);
    // A thread no topic points at raises nothing new. It is still reconciled
    // when it holds cards, because a topic delegated away from it would
    // otherwise strand them: the supervisor would keep showing questions about
    // work it no longer follows.
    if (topic === null && existing.length === 0) return SKIPPED;

    // Orphaned cards are cancelled without reading the thread: nothing is
    // delegated there, so no request on it belongs in this inbox either way.
    const open =
      topic === null
        ? NO_OPEN_REQUESTS
        : yield* snapshots
            .getThreadDetailById(threadId, { activityKinds: THREAD_REQUEST_ACTIVITY_KINDS })
            .pipe(
              Effect.map((detail) => (Option.isNone(detail) ? null : openRequests(detail.value))),
            );
    if (open === null) return SKIPPED;
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
    // A card belongs to the topic delegated here, so an orphaned thread only
    // ever sheds cards; `open` is empty for it and this loop does not run.
    if (topic !== null) {
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

  /**
   * A delegation names one thread and implies the rest, so the threads it
   * touches are read from the workspace here rather than in the stream loop.
   * A delegation that touches none — a topic undelegated from a thread holding
   * no cards — reconciles nothing and publishes no receipt.
   */
  const threadsForTask = (task: ReconcileTask) =>
    task.kind === "thread"
      ? Effect.succeed<ReadonlyArray<ThreadId>>([task.threadId])
      : snapshots.getProjectShellById(task.projectId).pipe(
          Effect.map((project) =>
            delegationReconcileThreadIds({
              workspace: Option.isNone(project) ? null : (project.value.firstMate ?? null),
              threadId: task.threadId,
            }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("FirstMate delegation reconcile could not read its project", {
                  projectId: task.projectId,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as([])),
          ),
        );

  const worker = yield* makeDrainableWorker((task: ReconcileTask) =>
    Effect.flatMap(threadsForTask(task), (threadIds) =>
      Effect.forEach(threadIds, processThread, { discard: true }),
    ),
  );

  const start: FirstMateRequestDecisionReactor["Service"]["start"] = Effect.fn(
    "FirstMateRequestDecisionReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        const task = reconcileTaskForEvent(event);
        return task === null ? Effect.void : worker.enqueue(task);
      }),
    );
  });

  return { start, drain: worker.drain } satisfies FirstMateRequestDecisionReactor["Service"];
});

export const layer = Layer.effect(FirstMateRequestDecisionReactor, make);
