import {
  CommandId,
  EventId,
  THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS,
  ThreadQueuedMessageClosedActivityPayload,
  ThreadQueuedMessageEnqueuedActivityPayload,
  ThreadQueuedMessageHeldActivityPayload,
  ThreadQueuedMessageReleasedActivityPayload,
  foldThreadQueuedMessages,
  isThreadQueuedMessageDue,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type PendingThreadQueuedMessage,
  type ThreadId,
  type ThreadQueuedMessageCloseReason,
  type ThreadQueuedMessageId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadQueuedMessageReactor,
  type ThreadQueuedMessageReactorShape,
} from "../Services/ThreadQueuedMessageReactor.ts";

const decodeEnqueued = Schema.decodeUnknownOption(ThreadQueuedMessageEnqueuedActivityPayload);
const decodeClosed = Schema.decodeUnknownOption(ThreadQueuedMessageClosedActivityPayload);
const decodeHeld = Schema.decodeUnknownOption(ThreadQueuedMessageHeldActivityPayload);
const decodeReleased = Schema.decodeUnknownOption(ThreadQueuedMessageReleasedActivityPayload);

/**
 * The activity kind a finished tool call appends. A message queued mid-turn
 * leaves on the first one of these, so it lands on a pause in the agent's work
 * instead of interrupting it mid-thought.
 */
const TOOL_COMPLETED_ACTIVITY_KIND = "tool.completed";
/**
 * The provider reported that the turn we just started never took off. The
 * message is already out of the queue, but the queue must stop waiting for a
 * session that is not coming.
 */
const TURN_START_FAILED_ACTIVITY_KIND = "provider.turn.start.failed";

type QueueWorkItem = OrchestrationEvent | { readonly evaluate: ThreadId };

interface ThreadQueueState {
  /** Pending entries, oldest first. Only the head is ever dispatched. */
  queue: Array<PendingThreadQueuedMessage>;
  /** Entries a tool call has finished behind since they were queued. */
  boundaryPassed: Set<ThreadQueuedMessageId>;
  /**
   * A turn start went out and the provider has not reported a session yet.
   * Mirrors the composer's old send-busy gate: without it a queue would empty
   * itself in one pass while the thread still looks idle.
   */
  awaitingSession: boolean;
}

function emptyState(): ThreadQueueState {
  return { queue: [], boundaryPassed: new Set(), awaitingSession: false };
}

/**
 * Apply one activity to a thread's in-memory queue.
 *
 * The queue is folded from the durable log at startup and kept current here, so
 * this mirrors `foldThreadQueuedMessages` rather than re-running it: an entry's
 * hold and release live only on the in-memory entry, and re-folding from the
 * enqueue records alone would quietly drop them.
 */
function applyQueueActivity(state: ThreadQueueState, activity: OrchestrationThreadActivity): void {
  switch (activity.kind) {
    case THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.enqueued: {
      const payload = decodeEnqueued(activity.payload);
      if (payload._tag === "None") break;
      const queuedMessageId = payload.value.queuedMessageId;
      // A replayed enqueue must not duplicate an entry already in the queue.
      if (state.queue.some((entry) => entry.queuedMessageId === queuedMessageId)) break;
      state.queue.push({
        queuedMessageId,
        enqueued: payload.value,
        held: false,
        heldDetail: "",
        released: false,
        activityId: activity.id,
      });
      break;
    }
    case THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.closed: {
      const payload = decodeClosed(activity.payload);
      if (payload._tag === "None") break;
      state.queue = state.queue.filter(
        (entry) => entry.queuedMessageId !== payload.value.queuedMessageId,
      );
      state.boundaryPassed.delete(payload.value.queuedMessageId);
      break;
    }
    case THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.held: {
      const payload = decodeHeld(activity.payload);
      if (payload._tag === "None") break;
      state.queue = state.queue.map((entry) =>
        entry.queuedMessageId === payload.value.queuedMessageId
          ? { ...entry, held: true, heldDetail: payload.value.detail, released: false }
          : entry,
      );
      break;
    }
    case THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.released: {
      const payload = decodeReleased(activity.payload);
      if (payload._tag === "None") break;
      state.queue = state.queue.map((entry) =>
        entry.queuedMessageId === payload.value.queuedMessageId
          ? { ...entry, held: false, heldDetail: "", released: true }
          : entry,
      );
      break;
    }
    case TOOL_COMPLETED_ACTIVITY_KIND: {
      for (const entry of state.queue) {
        state.boundaryPassed.add(entry.queuedMessageId);
      }
      break;
    }
    case TURN_START_FAILED_ACTIVITY_KIND: {
      state.awaitingSession = false;
      break;
    }
    default:
      break;
  }
}

/** Whether an activity can change a thread's queue at all. */
function isQueueActivity(kind: string): boolean {
  return (
    kind === THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.enqueued ||
    kind === THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.closed ||
    kind === THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.held ||
    kind === THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.released ||
    kind === TOOL_COMPLETED_ACTIVITY_KIND ||
    kind === TURN_START_FAILED_ACTIVITY_KIND
  );
}

/**
 * Restore every thread's queue from the durable activity log.
 *
 * The bootstrap command read model carries no activities, so the queue cannot
 * come back from the engine's in-memory state. Reading the enqueue records by
 * kind gives every live entry and the thread it belongs to (the enqueue payload
 * carries `threadId` for exactly this), and the close/hold/release records that
 * followed are applied on top.
 */
const seedQueues = Effect.fn("ThreadQueuedMessageReactor.seed")(function* (
  snapshots: ProjectionSnapshotQuery["Service"],
) {
  const byKind = yield* Effect.forEach(
    [
      THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.enqueued,
      THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.closed,
      THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.held,
      THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.released,
    ],
    (kind) => snapshots.listActivitiesByKind(kind),
    { concurrency: 1 },
  );
  const threadByQueuedMessageId = new Map<string, ThreadId>();
  for (const activity of byKind[0] ?? []) {
    const payload = decodeEnqueued(activity.payload);
    if (payload._tag === "None") continue;
    threadByQueuedMessageId.set(payload.value.queuedMessageId, payload.value.threadId);
  }
  const activitiesByThread = new Map<ThreadId, Array<OrchestrationThreadActivity>>();
  for (const activity of byKind.flat()) {
    const payload = activity.payload;
    const queuedMessageId =
      typeof payload === "object" && payload !== null && "queuedMessageId" in payload
        ? (payload as { queuedMessageId?: unknown }).queuedMessageId
        : undefined;
    if (typeof queuedMessageId !== "string") continue;
    const threadId = threadByQueuedMessageId.get(queuedMessageId);
    if (threadId === undefined) continue;
    const bucket = activitiesByThread.get(threadId);
    if (bucket) bucket.push(activity);
    else activitiesByThread.set(threadId, [activity]);
  }
  const states = new Map<ThreadId, ThreadQueueState>();
  for (const [threadId, activities] of activitiesByThread) {
    activities.sort(
      (left, right) =>
        (left.sequence ?? 0) - (right.sequence ?? 0) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
    const queue = [...foldThreadQueuedMessages(activities)];
    if (queue.length === 0) continue;
    states.set(threadId, { queue, boundaryPassed: new Set(), awaitingSession: false });
  }
  return states;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const states = new Map<ThreadId, ThreadQueueState>();
  const stateFor = (threadId: ThreadId) => {
    const existing = states.get(threadId);
    if (existing) return existing;
    const created = emptyState();
    states.set(threadId, created);
    return created;
  };

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  /** Append one queue bookkeeping record. Server-owned, so it skips the client command. */
  const appendQueueActivity = Effect.fn("ThreadQueuedMessageReactor.appendActivity")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly kind: string;
      readonly summary: string;
      readonly payload: Record<string, unknown>;
    }) {
      const commandId = yield* serverCommandId("queued-message");
      const activityId = EventId.make(yield* crypto.randomUUIDv4);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: activityId,
          tone: "info",
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    },
  );

  const closeEntry = (input: {
    readonly threadId: ThreadId;
    readonly queuedMessageId: ThreadQueuedMessageId;
    readonly reason: ThreadQueuedMessageCloseReason;
  }) =>
    appendQueueActivity({
      threadId: input.threadId,
      kind: THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.closed,
      summary:
        input.reason === "dispatched" ? "Queued message sent" : "Queued message left the queue",
      payload: { queuedMessageId: input.queuedMessageId, reason: input.reason },
    });

  /**
   * Start the head of the queue when the thread is ready for it. At most one
   * message leaves per evaluation: the rest lose their boundary and wait for
   * the next one, which is what keeps a queue from emptying into a single turn.
   */
  const evaluate = Effect.fn("ThreadQueuedMessageReactor.evaluate")(function* (threadId: ThreadId) {
    const state = states.get(threadId);
    if (!state || state.queue.length === 0 || state.awaitingSession) return;
    const head = state.queue[0]!;
    const shell = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell)) {
      // Deleted or archived while the queue waited. Nothing to send it to.
      states.delete(threadId);
      return;
    }
    const thread = shell.value;
    const due = isThreadQueuedMessageDue({
      entry: head,
      sessionStatus: thread.session?.status ?? null,
      blockedByPendingRequest: thread.hasPendingApprovals || thread.hasPendingUserInput,
      boundaryPassed: state.boundaryPassed.has(head.queuedMessageId),
    });
    if (!due) return;

    const commandId = yield* serverCommandId("queued-message-turn");
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const exit = yield* Effect.exit(
      engine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: head.enqueued.message,
        ...(head.enqueued.modelSelection !== undefined
          ? { modelSelection: head.enqueued.modelSelection }
          : {}),
        ...(head.enqueued.titleSeed !== undefined ? { titleSeed: head.enqueued.titleSeed } : {}),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      }),
    );
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
      // The entry keeps its place and waits for Send now. Retrying it on every
      // boundary would block everything behind it forever.
      yield* appendQueueActivity({
        threadId,
        kind: THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.held,
        summary: "Queued message was not sent",
        payload: {
          queuedMessageId: head.queuedMessageId,
          detail: Cause.pretty(exit.cause),
        },
      }).pipe(Effect.ignore({ log: true, message: "failed to hold queued message" }));
      return;
    }
    // Drop the entry here rather than waiting for the receipt to come back
    // through the projector: anything that cleared `awaitingSession` in that
    // window would otherwise start the same turn twice.
    state.queue = state.queue.slice(1);
    state.awaitingSession = true;
    state.boundaryPassed.clear();
    yield* closeEntry({
      threadId,
      queuedMessageId: head.queuedMessageId,
      reason: "dispatched",
    }).pipe(Effect.ignore({ log: true, message: "failed to close dispatched queued message" }));
  });

  /** Stop drains the queue: nothing the user just interrupted may start a new turn. */
  const cancelQueue = Effect.fn("ThreadQueuedMessageReactor.cancelQueue")(function* (
    threadId: ThreadId,
  ) {
    const state = states.get(threadId);
    if (!state || state.queue.length === 0) return;
    const canceled = state.queue;
    state.queue = [];
    state.boundaryPassed.clear();
    for (const entry of canceled) {
      yield* closeEntry({
        threadId,
        queuedMessageId: entry.queuedMessageId,
        reason: "interrupted",
      }).pipe(Effect.ignore({ log: true, message: "failed to cancel queued message" }));
    }
  });

  const handle = Effect.fn("ThreadQueuedMessageReactor.handle")(function* (
    event: OrchestrationEvent,
  ) {
    switch (event.type) {
      case "thread.activity-appended": {
        const { threadId, activity } = event.payload;
        if (!isQueueActivity(activity.kind)) return;
        const state = states.get(threadId);
        // Only spin up state for threads that actually queue something.
        if (!state && activity.kind !== THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.enqueued) return;
        applyQueueActivity(state ?? stateFor(threadId), activity);
        yield* evaluate(threadId);
        return;
      }
      case "thread.session-set": {
        const state = states.get(event.payload.threadId);
        if (!state) return;
        state.awaitingSession = false;
        yield* evaluate(event.payload.threadId);
        return;
      }
      case "thread.turn-interrupt-requested":
      case "thread.session-stop-requested": {
        yield* cancelQueue(event.payload.threadId);
        return;
      }
      case "thread.deleted":
      case "thread.archived": {
        states.delete(event.payload.threadId);
        return;
      }
      default:
        return;
    }
  });

  const handleSafely = (item: QueueWorkItem) =>
    ("evaluate" in item ? evaluate(item.evaluate) : handle(item)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("queued message reactor failed", {
              item: "evaluate" in item ? `evaluate:${item.evaluate}` : item.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(handleSafely);

  const start: ThreadQueuedMessageReactorShape["start"] = Effect.fn("start")(function* () {
    // Subscribe before reading the durable queue: an enqueue that lands between
    // the two would otherwise be seen by neither and sit forever.
    const domainEvents = yield* engine.subscribeDomainEvents;
    const seeded = yield* seedQueues(snapshots).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued message reactor failed to restore queues", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(new Map<ThreadId, ThreadQueueState>())),
      ),
    );
    for (const [threadId, state] of seeded) states.set(threadId, state);
    yield* forkParked(Stream.runForEach(domainEvents, (event) => worker.enqueue(event)));
    // A queue restored from a crashed run has no event to wake it, so give
    // every restored thread one evaluation.
    for (const threadId of seeded.keys()) {
      yield* worker.enqueue({ evaluate: threadId });
    }
  });

  return { start, drain: worker.drain } satisfies ThreadQueuedMessageReactorShape;
});

export const ThreadQueuedMessageReactorLive = Layer.effect(ThreadQueuedMessageReactor, make);
