/**
 * Pending composer queue derived from thread activities.
 *
 * The queue is server state: entries are appended to the thread's activity log
 * and folded back into pending entries here, the same way approval and
 * user-input requests are derived in the decider. Keeping the projection a
 * pure fold means the server, web, and mobile all read the same queue from the
 * activities they already receive — no extra read model, no extra wire traffic.
 *
 * @module threadQueuedMessages
 */
import * as Schema from "effect/Schema";

import type { EventId, ThreadQueuedMessageId } from "./baseSchemas.ts";
import {
  THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS,
  ThreadQueuedMessageClosedActivityPayload,
  ThreadQueuedMessageEnqueuedActivityPayload,
  ThreadQueuedMessageHeldActivityPayload,
  ThreadQueuedMessageReleasedActivityPayload,
  type OrchestrationThreadActivity,
} from "./orchestration.ts";

const decodeEnqueued = Schema.decodeUnknownOption(ThreadQueuedMessageEnqueuedActivityPayload);
const decodeClosed = Schema.decodeUnknownOption(ThreadQueuedMessageClosedActivityPayload);
const decodeHeld = Schema.decodeUnknownOption(ThreadQueuedMessageHeldActivityPayload);
const decodeReleased = Schema.decodeUnknownOption(ThreadQueuedMessageReleasedActivityPayload);

/** One message waiting to start a turn, with the mutations applied in order. */
export interface PendingThreadQueuedMessage {
  readonly queuedMessageId: ThreadQueuedMessageId;
  readonly enqueued: ThreadQueuedMessageEnqueuedActivityPayload;
  /**
   * Parked for the user: its dispatch failed, or it was queued by something
   * other than a send. It waits for Send now instead of leaving on its own.
   */
  readonly held: boolean;
  /** Why it is held, for the row's status line. Empty when it is not held. */
  readonly heldDetail: string;
  /** Send now was pressed: due on the next evaluation regardless of timing. */
  readonly released: boolean;
  /** Activity id of the enqueue record, so callers can anchor on its position. */
  readonly activityId: EventId;
}

/**
 * Fold a thread's activities into its pending queue, oldest first.
 *
 * A closed entry is collected up front rather than removed in order. Activities
 * only carry a sort key when their producer sets one, so an entry and the
 * receipt that closed it can land in the same millisecond and sort either way;
 * a closed entry that outlived its receipt would sit in the queue forever.
 * Unknown or malformed payloads are skipped rather than throwing — a newer
 * server must be able to add a field without breaking older readers.
 */
export function foldThreadQueuedMessages(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingThreadQueuedMessage> {
  const closed = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.closed) continue;
    const payload = decodeClosed(activity.payload);
    if (payload._tag === "Some") closed.add(payload.value.queuedMessageId);
  }
  const pending = new Map<string, PendingThreadQueuedMessage>();
  for (const activity of activities) {
    switch (activity.kind) {
      case THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.enqueued: {
        const payload = decodeEnqueued(activity.payload);
        if (payload._tag === "None") break;
        if (closed.has(payload.value.queuedMessageId)) break;
        // A replayed enqueue must not duplicate an entry already in the queue.
        if (pending.has(payload.value.queuedMessageId)) break;
        pending.set(payload.value.queuedMessageId, {
          queuedMessageId: payload.value.queuedMessageId,
          enqueued: payload.value,
          held: false,
          heldDetail: "",
          released: false,
          activityId: activity.id,
        });
        break;
      }
      case THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.held: {
        const payload = decodeHeld(activity.payload);
        if (payload._tag === "None") break;
        const entry = pending.get(payload.value.queuedMessageId);
        if (!entry) break;
        pending.set(entry.queuedMessageId, {
          ...entry,
          held: true,
          heldDetail: payload.value.detail,
          released: false,
        });
        break;
      }
      case THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.released: {
        const payload = decodeReleased(activity.payload);
        if (payload._tag === "None") break;
        const entry = pending.get(payload.value.queuedMessageId);
        if (!entry) break;
        pending.set(entry.queuedMessageId, {
          ...entry,
          held: false,
          heldDetail: "",
          released: true,
        });
        break;
      }
      default:
        break;
    }
  }
  return [...pending.values()];
}

/**
 * Whether the head of the queue may start its turn now.
 *
 * Mirrors what the composer used to decide locally, with the same rules: a
 * pending question or approval blocks the queue (a steer would answer neither),
 * a starting session is the gap between a send and the provider picking it up,
 * and a mid-turn message waits for a tool call to finish so it lands on a
 * natural pause instead of interrupting mid-thought.
 */
export function isThreadQueuedMessageDue(input: {
  readonly entry: Pick<PendingThreadQueuedMessage, "held" | "released" | "enqueued">;
  readonly sessionStatus:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error"
    | null;
  readonly blockedByPendingRequest: boolean;
  /** A tool call finished after this entry was queued. */
  readonly boundaryPassed: boolean;
}): boolean {
  if (input.blockedByPendingRequest) return false;
  if (input.entry.released) return true;
  if (input.entry.held) return false;
  if (input.sessionStatus === "starting") return false;
  if (input.sessionStatus !== "running") return true;
  if (input.entry.enqueued.dispatchTiming === "after-current-turn") return false;
  return input.boundaryPassed;
}
