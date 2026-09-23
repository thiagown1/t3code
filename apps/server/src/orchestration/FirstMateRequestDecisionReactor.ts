/**
 * FirstMateRequestDecisionReactor - lifts a project's pending requests into the
 * FirstMate supervisor's decision inbox.
 *
 * A user running seven threads at once should not have to open each one to find
 * out which is waiting on them. When any thread in a project with a FirstMate
 * workspace raises an approval or user-input request, this reactor opens a
 * decision on that workspace, so the request shows up in the same
 * blocking-first feed as the decisions the supervisor asks itself.
 *
 * A pending request belongs to the thread that raised it, not to a topic.
 * Topics are orchestration - durable work the user named - and most threads
 * never get one, so requiring delegation left the inbox empty for exactly the
 * user this exists for. A card still carries the topic delegated to its thread
 * when there is one, because that is the better label; it no longer needs one
 * to exist.
 *
 * Two things stay out: the supervisor thread, which would otherwise become a
 * source of its own inbox, and requests `firstMateRequestDecisions` cannot
 * state exactly, which stay pending on their own thread.
 *
 * Each pass reconciles rather than reacts: it recomputes the thread's open
 * requests and makes the workspace match. That is what makes it idempotent
 * (a repeated pass re-derives the same decision id, which the decider rejects
 * as a duplicate) and what closes the loop when the user answers a request in
 * the thread itself (the request is no longer open, so its card is cancelled
 * and leaves the inbox). A card leaves the inbox only when its request closed,
 * never because delegation moved: delegation no longer decides what is
 * projected, so it must not take a live question away from the user.
 *
 * Request activity on a thread is the steady-state trigger, but it only ever
 * catches threads that block *after* FirstMate is watching. A user who turns
 * FirstMate on, or restarts the server, is usually already blocked on several
 * threads, and those requests raise no new event - so without a scan the inbox
 * stays empty for exactly the person it exists for. Linking a supervisor and
 * server start therefore each run a backfill, and a topic being delegated
 * re-checks the thread it names.
 *
 * The scan is cheap by construction. The shell snapshot already records which
 * threads are blocked on the user, so only those have their detail read; a
 * project with hundreds of settled threads costs one snapshot and nothing
 * more. It runs parked off the boot path and, like every other pass here,
 * logs and moves on if it fails. Re-running it opens nothing twice, because a
 * card's id is derived from its thread and request.
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
  type OrchestrationShellSnapshot,
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
 * What one trigger asks this reactor to re-check.
 *
 * `thread` is the steady state, and the same event stream carries both halves
 * of that loop: a `*.requested` opens a card, a `*.resolved` in the thread
 * closes it. `backfill` is a scan, for the triggers that know a project may
 * hold blocked threads but cannot name them - FirstMate being switched on, and
 * server start. A null `projectId` means every supervised project.
 */
type ReconcileTask =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "backfill"; readonly projectId: ProjectId | null };

/** Server start: sweep every project FirstMate already supervises. */
const BACKFILL_EVERY_PROJECT: ReconcileTask = { kind: "backfill", projectId: null };

function reconcileTaskForEvent(event: OrchestrationEvent): ReconcileTask | null {
  if (event.type === "thread.activity-appended") {
    return REQUEST_ACTIVITY_KINDS.has(event.payload.activity.kind)
      ? { kind: "thread", threadId: event.payload.threadId }
      : null;
  }
  if (event.type !== "firstmate.domain-event") return null;
  // Linking a supervisor is the moment a project starts being watched, and the
  // threads it is already blocked on raise nothing new to announce themselves.
  if (event.payload.type === "firstmate.supervisor-linked") {
    return event.payload.threadId === null
      ? null
      : { kind: "backfill", projectId: event.payload.projectId };
  }
  if (event.payload.type === "firstmate.topic-delegated" && event.payload.threadId !== null) {
    return { kind: "thread", threadId: event.payload.threadId };
  }
  return null;
}

/**
 * Threads a scan has to re-check: the ones a supervised project is already
 * blocked on.
 *
 * `hasPendingApprovals` and `hasPendingUserInput` come free with the shell, and
 * reading a thread's detail is the expensive half of a pass, so a project with
 * hundreds of settled threads is filtered down to the handful actually waiting
 * on the user without touching one of them. The supervisor is dropped here so
 * the scan does not queue a pass that only exists to be skipped; every other
 * rule - archived, deleted, no workspace - still belongs to the pass itself.
 *
 * @internal Exported for tests.
 */
export function firstMateBackfillThreadIds(
  snapshot: Pick<OrchestrationShellSnapshot, "projects" | "threads">,
  projectId: ProjectId | null,
): ReadonlyArray<ThreadId> {
  const supervisorByProjectId = new Map<ProjectId, ThreadId | null>();
  for (const project of snapshot.projects) {
    if (projectId !== null && project.id !== projectId) continue;
    const workspace = project.firstMate;
    if (workspace === null || workspace === undefined) continue;
    supervisorByProjectId.set(project.id, workspace.supervisorThreadId);
  }
  if (supervisorByProjectId.size === 0) return [];

  const threadIds: ThreadId[] = [];
  for (const thread of snapshot.threads) {
    if (!supervisorByProjectId.has(thread.projectId)) continue;
    if (supervisorByProjectId.get(thread.projectId) === thread.id) continue;
    if (!thread.hasPendingApprovals && !thread.hasPendingUserInput) continue;
    threadIds.push(thread.id);
  }
  return threadIds;
}

/** Pending cards this workspace already holds for requests on one thread. */
function pendingRequestDecisions(
  workspace: FirstMateWorkspaceState,
  threadId: ThreadId,
): ReadonlyArray<FirstMateDecision & { readonly requestId: ApprovalRequestId }> {
  return workspace.decisions.flatMap((decision) =>
    decision.status === "pending" &&
    (decision.source.kind === "user-input" || decision.source.kind === "approval") &&
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

    // A label, not a gate. The thread is projected either way; a topic
    // delegated here just gives its cards a better name than the thread title.
    const topic = workspace.topics.find((entry) => entry.threadId === threadId) ?? null;
    const existing = pendingRequestDecisions(workspace, threadId);

    const detail = yield* snapshots.getThreadDetailById(threadId, {
      activityKinds: THREAD_REQUEST_ACTIVITY_KINDS,
    });
    if (Option.isNone(detail)) return SKIPPED;
    const open = openRequests(detail.value);
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
        topicId: topic?.id ?? null,
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
    // Only a closed request sheds its card: answered in the thread, cancelled,
    // or gone stale. Delegation moving is not a reason to take a live question
    // away from the user, because the question was never the topic's to begin
    // with.
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
   * A scan reads one snapshot and fans out from it. Failing to read it costs
   * the backfill, never the reactor: request activity still opens cards, and
   * the next start scans again.
   */
  const threadsForTask = (task: ReconcileTask) =>
    task.kind === "thread"
      ? Effect.succeed<ReadonlyArray<ThreadId>>([task.threadId])
      : snapshots.getShellSnapshot().pipe(
          Effect.map((snapshot) => firstMateBackfillThreadIds(snapshot, task.projectId)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("FirstMate request decision backfill could not read the shell", {
                  projectId: task.projectId,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as<ReadonlyArray<ThreadId>>([])),
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
    // Parked with the stream, so a restart catches up on everything that was
    // already waiting without holding up the boot that has to serve it.
    yield* forkParked(worker.enqueue(BACKFILL_EVERY_PROJECT));
  });

  return { start, drain: worker.drain } satisfies FirstMateRequestDecisionReactor["Service"];
});

export const layer = Layer.effect(FirstMateRequestDecisionReactor, make);
