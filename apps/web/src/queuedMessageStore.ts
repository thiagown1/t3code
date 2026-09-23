import {
  PreviewAnnotationPayloadSchema,
  THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS,
  ThreadQueuedMessageClosedActivityPayload,
  foldThreadQueuedMessages,
  type OrchestrationThreadActivity,
  type PreviewAnnotationPayload,
  type ThreadQueuedMessageDispatchTiming,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import type { ComposerQueueTiming } from "./composer-logic";
import {
  hydrateComposerFileAttachment,
  hydrateImagesFromPersisted,
  PersistedComposerDraftFileAttachment,
  PersistedComposerImageAttachment,
  persistComposerFileAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { ReviewCommentContextSchema, type ReviewCommentContext } from "./reviewCommentContext";

const QUEUED_MESSAGE_STORAGE_KEY = "t3code:queued-composer-restore:v1";
const QUEUED_MESSAGE_STORAGE_VERSION = 1;
/**
 * Where the queue itself used to live. The server owns the queue now, so this
 * key is only read once, to hand any message a previous build was still holding
 * back to the composer. See `takeLegacyQueuedMessages`.
 */
const LEGACY_QUEUE_STORAGE_KEY = "t3code:queued-composer-messages:v1";
const MAX_RESTORE_SNAPSHOTS = 200;

/** An explicit wait-until-finished send overrides the client's default steer preference. */
export function shouldQueueRunningFollowUp(
  followUpBehavior: "queue" | "steer",
  timing: ComposerQueueTiming | undefined,
): boolean {
  return timing === "after-current-turn" || followUpBehavior === "queue";
}

const isPersistedImage = Schema.is(PersistedComposerImageAttachment);
const isPersistedFile = Schema.is(PersistedComposerDraftFileAttachment);
const isPreviewAnnotation = Schema.is(PreviewAnnotationPayloadSchema);
const isReviewComment = Schema.is(ReviewCommentContextSchema);
const decodeClosedActivity = Schema.decodeUnknownOption(ThreadQueuedMessageClosedActivityPayload);

/**
 * One row of the thread's server-owned queue, flattened for the timeline.
 *
 * The wire model is the enqueue activity the server already streams, so nothing
 * extra crosses the socket for this. Only counts are kept: the row shows "2
 * attachments", never the attachments themselves.
 */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  attachmentCount: number;
  contextItemCount: number;
  dispatchTiming: ThreadQueuedMessageDispatchTiming;
  /** Parked after a failed dispatch: it waits for Send now instead of leaving on its own. */
  holdUntilUserAction: boolean;
  createdAt: string;
}

/**
 * What the composer had when the message was queued, kept locally so Cancel and
 * Stop can hand the whole draft back — attachments included. The server's copy
 * of the message is authoritative for sending; this is only for restoring, and
 * a device that never saw the queueing simply restores the text.
 */
export interface QueuedComposerRestoreSnapshot {
  /** The prompt as typed, before provider formatting. */
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  persistedImages: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
}

interface QueuedMessageRestoreStoreState {
  snapshotsByQueuedMessageId: Record<string, QueuedComposerRestoreSnapshot>;
  remember: (queuedMessageId: string, snapshot: QueuedComposerRestoreSnapshot) => void;
  /** Reads and forgets one snapshot. Null when this client never held it. */
  take: (queuedMessageId: string) => QueuedComposerRestoreSnapshot | null;
  forget: (queuedMessageIds: ReadonlyArray<string>) => void;
}

interface PersistedRestoreSnapshot extends Omit<
  QueuedComposerRestoreSnapshot,
  "files" | "images" | "persistedImages"
> {
  images: PersistedComposerImageAttachment[];
  files: PersistedComposerDraftFileAttachment[];
}

interface PersistedRestoreStoreState {
  snapshotsByQueuedMessageId: Record<string, PersistedRestoreSnapshot>;
}

type RestorePersistState =
  | { capturedState: QueuedMessageRestoreStoreState }
  | PersistedRestoreStoreState;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalContext(value: unknown): value is TerminalContextDraft {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.terminalId === "string" &&
    typeof value.terminalLabel === "string" &&
    typeof value.lineStart === "number" &&
    typeof value.lineEnd === "number" &&
    typeof value.text === "string"
  );
}

function normalizePersistedSnapshot(value: unknown): PersistedRestoreSnapshot | null {
  if (!isRecord(value) || typeof value.prompt !== "string") return null;
  return {
    prompt: value.prompt,
    images: Array.isArray(value.images) ? value.images.filter(isPersistedImage) : [],
    files: Array.isArray(value.files) ? value.files.filter(isPersistedFile) : [],
    terminalContexts: Array.isArray(value.terminalContexts)
      ? value.terminalContexts.filter(isTerminalContext)
      : [],
    previewAnnotations: Array.isArray(value.previewAnnotations)
      ? value.previewAnnotations.filter(isPreviewAnnotation)
      : [],
    reviewComments: Array.isArray(value.reviewComments)
      ? value.reviewComments.filter(isReviewComment)
      : [],
  };
}

export function normalizePersistedRestoreStoreState(value: unknown): PersistedRestoreStoreState {
  if (!isRecord(value) || !isRecord(value.snapshotsByQueuedMessageId)) {
    return { snapshotsByQueuedMessageId: {} };
  }
  const entries = Object.entries(value.snapshotsByQueuedMessageId)
    .slice(-MAX_RESTORE_SNAPSHOTS)
    .flatMap(([queuedMessageId, snapshot]) => {
      if (queuedMessageId.length === 0) return [];
      const normalized = normalizePersistedSnapshot(snapshot);
      return normalized ? [[queuedMessageId, normalized] as const] : [];
    });
  return { snapshotsByQueuedMessageId: Object.fromEntries(entries) };
}

export function partializeRestoreStoreState(
  state: QueuedMessageRestoreStoreState,
): PersistedRestoreStoreState {
  return normalizePersistedRestoreStoreState({
    snapshotsByQueuedMessageId: Object.fromEntries(
      Object.entries(state.snapshotsByQueuedMessageId).map(([queuedMessageId, snapshot]) => [
        queuedMessageId,
        {
          ...snapshot,
          images: snapshot.persistedImages,
          files: snapshot.files.map(persistComposerFileAttachment),
          persistedImages: undefined,
        },
      ]),
    ),
  });
}

export function hydratePersistedRestoreStoreState(
  value: unknown,
): Pick<QueuedMessageRestoreStoreState, "snapshotsByQueuedMessageId"> {
  const persisted = normalizePersistedRestoreStoreState(value);
  return {
    snapshotsByQueuedMessageId: Object.fromEntries(
      Object.entries(persisted.snapshotsByQueuedMessageId).map(([queuedMessageId, snapshot]) => [
        queuedMessageId,
        {
          ...snapshot,
          images: hydrateImagesFromPersisted(snapshot.images),
          persistedImages: [...snapshot.images],
          files: snapshot.files.map(hydrateComposerFileAttachment),
        },
      ]),
    ),
  };
}

function resolveQueuedMessageStorage(): StateStorage {
  try {
    return typeof localStorage === "undefined" ? createMemoryStorage() : localStorage;
  } catch {
    return createMemoryStorage();
  }
}

const queuedMessageBaseStorage = resolveQueuedMessageStorage();
const queuedMessagePersistStorage: PersistStorage<RestorePersistState> = {
  getItem: (name) => {
    const raw = queuedMessageBaseStorage.getItem(name);
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as StorageValue<RestorePersistState>;
    } catch {
      return null;
    }
  },
  setItem: (name, value) =>
    queuedMessageBaseStorage.setItem(
      name,
      JSON.stringify({
        state:
          "capturedState" in value.state
            ? partializeRestoreStoreState(value.state.capturedState)
            : value.state,
        version: value.version,
      }),
    ),
  removeItem: (name) => queuedMessageBaseStorage.removeItem(name),
};

export const useQueuedMessageRestoreStore = create<QueuedMessageRestoreStoreState>()(
  persist(
    (set, get) => ({
      snapshotsByQueuedMessageId: {},
      remember: (queuedMessageId, snapshot) => {
        set((state) => ({
          snapshotsByQueuedMessageId: {
            ...state.snapshotsByQueuedMessageId,
            [queuedMessageId]: snapshot,
          },
        }));
      },
      take: (queuedMessageId) => {
        const snapshot = get().snapshotsByQueuedMessageId[queuedMessageId];
        if (!snapshot) return null;
        set((state) => {
          const next = { ...state.snapshotsByQueuedMessageId };
          delete next[queuedMessageId];
          return { snapshotsByQueuedMessageId: next };
        });
        return snapshot;
      },
      forget: (queuedMessageIds) => {
        if (queuedMessageIds.length === 0) return;
        set((state) => {
          let changed = false;
          const next = { ...state.snapshotsByQueuedMessageId };
          for (const id of queuedMessageIds) {
            if (id in next) {
              delete next[id];
              changed = true;
            }
          }
          return changed ? { snapshotsByQueuedMessageId: next } : state;
        });
      },
    }),
    {
      name: QUEUED_MESSAGE_STORAGE_KEY,
      version: QUEUED_MESSAGE_STORAGE_VERSION,
      storage: queuedMessagePersistStorage,
      partialize: (state): RestorePersistState => ({ capturedState: state }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...hydratePersistedRestoreStoreState(persistedState),
      }),
    },
  ),
);

/**
 * Read and delete whatever the pre-server build left queued in this browser.
 *
 * Those messages were never sent and the server has no record of them, so they
 * are handed straight back to the composer of the thread that owned them rather
 * than replayed: replaying would start turns the user queued in a session that
 * may be hours old. Called once per thread, keyed by the same thread key the
 * old store used.
 */
export function takeLegacyQueuedMessages(
  threadKey: string,
  /** Injectable so the migration can be tested outside a browser. */
  storage: StateStorage = queuedMessageBaseStorage,
): QueuedComposerRestoreSnapshot[] {
  let parsed: unknown;
  try {
    const raw = storage.getItem(LEGACY_QUEUE_STORAGE_KEY);
    if (typeof raw !== "string") return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const state = isRecord(parsed) && isRecord(parsed.state) ? parsed.state : null;
  const queues = state && isRecord(state.queuesByThreadKey) ? state.queuesByThreadKey : null;
  if (!queues) return [];
  const queue = queues[threadKey];
  const messages = Array.isArray(queue)
    ? queue.flatMap((entry) => {
        const snapshot = normalizePersistedSnapshot(entry);
        return snapshot ? [snapshot] : [];
      })
    : [];
  const remaining = { ...queues };
  delete remaining[threadKey];
  try {
    if (Object.keys(remaining).length === 0) {
      storage.removeItem(LEGACY_QUEUE_STORAGE_KEY);
    } else {
      storage.setItem(
        LEGACY_QUEUE_STORAGE_KEY,
        JSON.stringify({
          ...(parsed as Record<string, unknown>),
          state: { ...state, queuesByThreadKey: remaining },
        }),
      );
    }
  } catch {
    // A full or unavailable store must not swallow the messages we just read.
  }
  return messages.map((message) => ({
    ...message,
    images: hydrateImagesFromPersisted(message.images),
    persistedImages: [...message.images],
    files: message.files.map(hydrateComposerFileAttachment),
  }));
}

/**
 * The newest finished tool call. Its id changing is the boundary a queued
 * message goes out on. Live arrays are sorted, but a snapshot loaded from the
 * database is not, so pick by sequence rather than position.
 */
export function latestCompletedToolActivityId(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly sequence?: number | undefined;
    readonly createdAt: string;
  }>,
): string | null {
  let latest: (typeof activities)[number] | null = null;
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    if (
      latest === null ||
      (activity.sequence ?? -1) > (latest.sequence ?? -1) ||
      ((activity.sequence ?? -1) === (latest.sequence ?? -1) &&
        activity.createdAt > latest.createdAt)
    ) {
      latest = activity;
    }
  }
  return latest?.id ?? null;
}

/** Flatten the thread's pending queue into timeline rows, oldest first. */
export function deriveQueuedMessages(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): QueuedComposerMessage[] {
  return foldThreadQueuedMessages(activities).map((entry) => ({
    id: entry.queuedMessageId,
    prompt: entry.enqueued.message.text,
    attachmentCount: entry.enqueued.message.attachments.length,
    contextItemCount: entry.enqueued.message.context?.records.length ?? 0,
    dispatchTiming: entry.enqueued.dispatchTiming,
    holdUntilUserAction: entry.held,
    createdAt: entry.enqueued.createdAt,
  }));
}

/**
 * Ids the server took out of the queue because the user pressed Stop.
 *
 * Stop cancels the queue so nothing starts a new turn the moment the
 * interrupted one settles; the composer takes those drafts back instead. Cancel
 * is deliberately not included: the client that pressed it restores the draft
 * itself, and a cancel from another device must not push text into this
 * composer.
 */
export function deriveInterruptedQueuedMessages(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string[] {
  const interrupted: string[] = [];
  for (const activity of activities) {
    if (activity.kind !== THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.closed) continue;
    const payload = decodeClosedActivity(activity.payload);
    if (payload._tag === "None" || payload.value.reason !== "interrupted") continue;
    interrupted.push(payload.value.queuedMessageId);
  }
  return interrupted;
}
