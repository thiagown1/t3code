import { PreviewAnnotationPayloadSchema, type PreviewAnnotationPayload } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import type { ComposerQueueTiming, ComposerSubmissionIntent } from "./composer-logic";
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
import { randomUUID } from "./lib/utils";
import { ReviewCommentContextSchema, type ReviewCommentContext } from "./reviewCommentContext";

export const QUEUED_MESSAGE_STORAGE_KEY = "t3code:queued-composer-messages:v1";
const QUEUED_MESSAGE_STORAGE_VERSION = 1;
const MAX_PERSISTED_QUEUE_THREADS = 100;
const MAX_PERSISTED_MESSAGES_PER_THREAD = 50;

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

/**
 * A composer submission held back while the thread's turn is running. It
 * carries the full draft snapshot so the send path can dispatch it later with
 * the same text, attachments, and contexts the user pressed Enter on.
 */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  persistedImages: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  submissionIntent: ComposerSubmissionIntent;
  dispatchTiming: ComposerQueueTiming;
  /**
   * The newest completed tool activity at queue time. A different id later
   * means a tool call finished after the user queued, which is the boundary
   * the message goes out on.
   */
  queuedAfterToolActivityId: string | null;
  /**
   * Set when the message was created by Stop or a failed restore, not by the
   * user pressing send. It waits for Send now instead of leaving on its own.
   */
  holdUntilUserAction?: boolean;
  createdAt: string;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  /**
   * Bumped by `drain`. A send that took a message before a drain and finishes
   * its upload after it compares this to the value it captured and gives up,
   * so Stop cannot be followed by a queued message starting a new turn.
   */
  drainGeneration: number;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  /**
   * Removes one message and returns it, or null when another caller already
   * took it. The remaining messages are re-anchored to `toolActivityId` so
   * only one queued message leaves per tool boundary.
   */
  take: (
    threadKey: string,
    id: string,
    toolActivityId: string | null,
  ) => QueuedComposerMessage | null;
  /** Removes one message without touching the others' anchors. Null when already gone. */
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  /**
   * Puts a message back at the head, held for user action. Used when its
   * send failed: the queue keeps its order and nothing behind it overtakes.
   */
  holdAtFront: (threadKey: string, message: QueuedComposerMessage) => void;
  /** Removes and returns every queued message for the thread, oldest first. */
  drain: (threadKey: string) => QueuedComposerMessage[];
}

interface PersistedQueuedComposerMessage extends Omit<
  QueuedComposerMessage,
  "files" | "images" | "persistedImages"
> {
  images: PersistedComposerImageAttachment[];
  files: PersistedComposerDraftFileAttachment[];
}

interface PersistedQueuedMessageStoreState {
  queuesByThreadKey: Record<string, PersistedQueuedComposerMessage[]>;
}

type QueuedMessagePersistState =
  | { capturedState: QueuedMessageStoreState }
  | PersistedQueuedMessageStoreState;

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

function normalizePersistedMessage(value: unknown): PersistedQueuedComposerMessage | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.prompt !== "string" ||
    (value.submissionIntent !== "foreground" && value.submissionIntent !== "background") ||
    (value.dispatchTiming !== "next-boundary" && value.dispatchTiming !== "after-current-turn") ||
    (value.queuedAfterToolActivityId !== null &&
      typeof value.queuedAfterToolActivityId !== "string") ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
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
    submissionIntent: value.submissionIntent,
    dispatchTiming: value.dispatchTiming,
    queuedAfterToolActivityId: value.queuedAfterToolActivityId,
    ...(typeof value.holdUntilUserAction === "boolean"
      ? { holdUntilUserAction: value.holdUntilUserAction }
      : {}),
    createdAt: value.createdAt,
  };
}

export function normalizePersistedQueuedMessageStoreState(
  value: unknown,
): PersistedQueuedMessageStoreState {
  if (!isRecord(value) || !isRecord(value.queuesByThreadKey)) {
    return { queuesByThreadKey: {} };
  }
  const entries = Object.entries(value.queuesByThreadKey)
    .slice(-MAX_PERSISTED_QUEUE_THREADS)
    .flatMap(([threadKey, queue]) => {
      if (threadKey.length === 0 || !Array.isArray(queue)) return [];
      const messages = queue
        .slice(0, MAX_PERSISTED_MESSAGES_PER_THREAD)
        .map(normalizePersistedMessage)
        .filter((message): message is PersistedQueuedComposerMessage => message !== null);
      return messages.length > 0 ? [[threadKey, messages] as const] : [];
    });
  return { queuesByThreadKey: Object.fromEntries(entries) };
}

export function partializeQueuedMessageStoreState(
  state: QueuedMessageStoreState,
): PersistedQueuedMessageStoreState {
  return normalizePersistedQueuedMessageStoreState({
    queuesByThreadKey: Object.fromEntries(
      Object.entries(state.queuesByThreadKey).map(([threadKey, queue]) => [
        threadKey,
        queue.map((message) => ({
          ...message,
          images: message.persistedImages,
          files: message.files.map(persistComposerFileAttachment),
          persistedImages: undefined,
        })),
      ]),
    ),
  });
}

export function hydratePersistedQueuedMessageStoreState(
  value: unknown,
): Pick<QueuedMessageStoreState, "queuesByThreadKey"> {
  const persisted = normalizePersistedQueuedMessageStoreState(value);
  return {
    queuesByThreadKey: Object.fromEntries(
      Object.entries(persisted.queuesByThreadKey).map(([threadKey, queue]) => [
        threadKey,
        queue.map((message) => ({
          ...message,
          images: hydrateImagesFromPersisted(message.images),
          persistedImages: [...message.images],
          files: message.files.map(hydrateComposerFileAttachment),
        })),
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
const queuedMessagePersistStorage: PersistStorage<QueuedMessagePersistState> = {
  getItem: (name) => {
    const raw = queuedMessageBaseStorage.getItem(name);
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as StorageValue<QueuedMessagePersistState>;
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
            ? partializeQueuedMessageStoreState(value.state.capturedState)
            : value.state,
        version: value.version,
      }),
    ),
  removeItem: (name) => queuedMessageBaseStorage.removeItem(name),
};

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

export const useQueuedMessageStore = create<QueuedMessageStoreState>()(
  persist(
    (set, get) => ({
      queuesByThreadKey: {},
      drainGeneration: 0,
      enqueue: (threadKey, message) => {
        const entry: QueuedComposerMessage = { ...message, id: randomUUID() };
        set((state) => ({
          queuesByThreadKey: {
            ...state.queuesByThreadKey,
            [threadKey]: [...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE), entry],
          },
        }));
        return entry;
      },
      take: (threadKey, id, toolActivityId) => {
        const queue = get().queuesByThreadKey[threadKey];
        const entry = queue?.find((message) => message.id === id);
        if (!queue || !entry) {
          return null;
        }
        set((state) => {
          const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE)
            .filter((message) => message.id !== id)
            .map((message) =>
              message.queuedAfterToolActivityId === toolActivityId
                ? message
                : { ...message, queuedAfterToolActivityId: toolActivityId },
            );
          const queuesByThreadKey = { ...state.queuesByThreadKey };
          if (remaining.length === 0) {
            delete queuesByThreadKey[threadKey];
          } else {
            queuesByThreadKey[threadKey] = remaining;
          }
          return { queuesByThreadKey };
        });
        return entry;
      },
      remove: (threadKey, id) => {
        const queue = get().queuesByThreadKey[threadKey];
        const entry = queue?.find((message) => message.id === id);
        if (!queue || !entry) {
          return null;
        }
        set((state) => {
          const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
            (message) => message.id !== id,
          );
          const queuesByThreadKey = { ...state.queuesByThreadKey };
          if (remaining.length === 0) {
            delete queuesByThreadKey[threadKey];
          } else {
            queuesByThreadKey[threadKey] = remaining;
          }
          return { queuesByThreadKey };
        });
        return entry;
      },
      holdAtFront: (threadKey, message) => {
        set((state) => {
          const rest = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
            (entry) => entry.id !== message.id,
          );
          return {
            queuesByThreadKey: {
              ...state.queuesByThreadKey,
              [threadKey]: [{ ...message, holdUntilUserAction: true }, ...rest],
            },
          };
        });
      },
      drain: (threadKey) => {
        const queue = get().queuesByThreadKey[threadKey];
        if (!queue || queue.length === 0) {
          return EMPTY_QUEUE;
        }
        set((state) => {
          const queuesByThreadKey = { ...state.queuesByThreadKey };
          delete queuesByThreadKey[threadKey];
          return { queuesByThreadKey, drainGeneration: state.drainGeneration + 1 };
        });
        return queue;
      },
    }),
    {
      name: QUEUED_MESSAGE_STORAGE_KEY,
      version: QUEUED_MESSAGE_STORAGE_VERSION,
      storage: queuedMessagePersistStorage,
      partialize: (state): QueuedMessagePersistState => ({ capturedState: state }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...hydratePersistedQueuedMessageStoreState(persistedState),
      }),
    },
  ),
);

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

/**
 * A queued message is due mid-turn once a tool call finished after it was
 * queued, and as soon as the turn is over otherwise. "connecting" is the gap
 * between a send and the provider picking it up, so nothing is due there.
 */
export function isQueuedMessageDue(input: {
  message: Pick<
    QueuedComposerMessage,
    "dispatchTiming" | "queuedAfterToolActivityId" | "holdUntilUserAction"
  >;
  phase: "connecting" | "running" | "ready" | "disconnected";
  latestToolActivityId: string | null;
}): boolean {
  if (input.message.holdUntilUserAction) return false;
  if (input.phase === "connecting") return false;
  if (input.phase !== "running") return true;
  if (input.message.dispatchTiming === "after-current-turn") return false;
  return input.latestToolActivityId !== input.message.queuedAfterToolActivityId;
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}
