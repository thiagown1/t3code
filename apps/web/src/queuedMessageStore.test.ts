import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  deriveInterruptedQueuedMessages,
  deriveQueuedMessages,
  hydratePersistedRestoreStoreState,
  latestCompletedToolActivityId,
  normalizePersistedRestoreStoreState,
  partializeRestoreStoreState,
  shouldQueueRunningFollowUp,
  takeLegacyQueuedMessages,
  useQueuedMessageRestoreStore,
} from "./queuedMessageStore";
import { createMemoryStorage } from "./lib/storage";

const QUEUED_MESSAGE_ID = "queued-1";

function enqueuedActivity(input: {
  id: string;
  queuedMessageId: string;
  text: string;
  sequence: number;
  attachments?: number;
  contextRecords?: number;
  dispatchTiming?: "next-boundary" | "after-current-turn";
}) {
  return {
    id: input.id,
    tone: "info" as const,
    kind: "thread.queued-message.enqueued",
    summary: "Message queued",
    payload: {
      threadId: "thread-1",
      queuedMessageId: input.queuedMessageId,
      message: {
        messageId: `message-${input.queuedMessageId}`,
        role: "user",
        text: input.text,
        attachments: Array.from({ length: input.attachments ?? 0 }, (_unused, index) => ({
          type: "image",
          id: `attachment-${index}`,
          name: "pixel.png",
          mimeType: "image/png",
          sizeBytes: 1,
        })),
        ...(input.contextRecords
          ? {
              context: {
                version: 1,
                records: Array.from({ length: input.contextRecords }, (_unused, index) => ({
                  version: 1,
                  kind: "terminal",
                  contextId: `ctx${index}`,
                  label: "terminal",
                  terminalId: "term-1",
                  terminalLabel: "bash",
                  lineStart: 1,
                  lineEnd: 2,
                  text: "log line",
                })),
              },
            }
          : {}),
      },
      dispatchTiming: input.dispatchTiming ?? "next-boundary",
      queuedAfterActivityId: null,
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    turnId: null,
    sequence: input.sequence,
    createdAt: "2026-01-01T00:00:01.000Z",
  };
}

function queueLifecycleActivity(input: {
  id: string;
  kind: string;
  sequence: number;
  payload: Record<string, unknown>;
}) {
  return {
    id: input.id,
    tone: "info" as const,
    kind: input.kind,
    summary: "Queue update",
    payload: input.payload,
    turnId: null,
    sequence: input.sequence,
    createdAt: "2026-01-01T00:00:02.000Z",
  };
}

describe("queue preference", () => {
  it("keeps Alt+Enter queued even when ordinary follow-ups steer immediately", () => {
    expect(shouldQueueRunningFollowUp("steer", "after-current-turn")).toBe(true);
    expect(shouldQueueRunningFollowUp("steer", undefined)).toBe(false);
    expect(shouldQueueRunningFollowUp("queue", undefined)).toBe(true);
  });
});

describe("deriveQueuedMessages", () => {
  it("keeps the server's order and reports only counts to the row", () => {
    const rows = deriveQueuedMessages([
      enqueuedActivity({
        id: "act-1",
        queuedMessageId: "q1",
        text: "first",
        sequence: 1,
        attachments: 2,
        contextRecords: 3,
      }),
      enqueuedActivity({ id: "act-2", queuedMessageId: "q2", text: "second", sequence: 2 }),
    ] as never);

    expect(rows.map((row) => row.id)).toEqual(["q1", "q2"]);
    expect(rows[0]).toMatchObject({
      prompt: "first",
      attachmentCount: 2,
      contextItemCount: 3,
      holdUntilUserAction: false,
    });
  });

  it("drops an entry the server closed and holds one it could not send", () => {
    const rows = deriveQueuedMessages([
      enqueuedActivity({ id: "act-1", queuedMessageId: "q1", text: "first", sequence: 1 }),
      enqueuedActivity({ id: "act-2", queuedMessageId: "q2", text: "second", sequence: 2 }),
      queueLifecycleActivity({
        id: "act-3",
        kind: "thread.queued-message.closed",
        sequence: 3,
        payload: { queuedMessageId: "q1", reason: "dispatched" },
      }),
      queueLifecycleActivity({
        id: "act-4",
        kind: "thread.queued-message.held",
        sequence: 4,
        payload: { queuedMessageId: "q2", detail: "provider rejected the turn" },
      }),
    ] as never);

    expect(rows.map((row) => row.id)).toEqual(["q2"]);
    expect(rows[0]?.holdUntilUserAction).toBe(true);
  });

  it("clears a hold when the user releases the entry", () => {
    const rows = deriveQueuedMessages([
      enqueuedActivity({ id: "act-1", queuedMessageId: "q1", text: "first", sequence: 1 }),
      queueLifecycleActivity({
        id: "act-2",
        kind: "thread.queued-message.held",
        sequence: 2,
        payload: { queuedMessageId: "q1", detail: "nope" },
      }),
      queueLifecycleActivity({
        id: "act-3",
        kind: "thread.queued-message.released",
        sequence: 3,
        payload: { queuedMessageId: "q1" },
      }),
    ] as never);

    expect(rows[0]?.holdUntilUserAction).toBe(false);
  });
});

describe("deriveInterruptedQueuedMessages", () => {
  it("reports only what Stop took out of the queue, with its text", () => {
    const interrupted = deriveInterruptedQueuedMessages([
      enqueuedActivity({ id: "act-1", queuedMessageId: "q1", text: "stopped", sequence: 1 }),
      enqueuedActivity({ id: "act-2", queuedMessageId: "q2", text: "sent", sequence: 2 }),
      queueLifecycleActivity({
        id: "act-3",
        kind: "thread.queued-message.closed",
        sequence: 3,
        payload: { queuedMessageId: "q2", reason: "dispatched" },
      }),
      queueLifecycleActivity({
        id: "act-4",
        kind: "thread.queued-message.closed",
        sequence: 4,
        payload: { queuedMessageId: "q1", reason: "interrupted" },
      }),
    ] as never);

    expect(interrupted).toEqual(["q1"]);
  });

  it("ignores a cancel, which the client that pressed it restores itself", () => {
    expect(
      deriveInterruptedQueuedMessages([
        enqueuedActivity({ id: "act-1", queuedMessageId: "q1", text: "canceled", sequence: 1 }),
        queueLifecycleActivity({
          id: "act-2",
          kind: "thread.queued-message.closed",
          sequence: 2,
          payload: { queuedMessageId: "q1", reason: "canceled" },
        }),
      ] as never),
    ).toEqual([]);
  });
});

describe("restore snapshots", () => {
  beforeEach(() => {
    useQueuedMessageRestoreStore.setState({ snapshotsByQueuedMessageId: {} });
  });

  it("hands a snapshot to exactly one caller", () => {
    const store = useQueuedMessageRestoreStore.getState();
    store.remember(QUEUED_MESSAGE_ID, {
      prompt: "held draft",
      images: [],
      files: [],
      persistedImages: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
    });

    expect(useQueuedMessageRestoreStore.getState().take(QUEUED_MESSAGE_ID)?.prompt).toBe(
      "held draft",
    );
    expect(useQueuedMessageRestoreStore.getState().take(QUEUED_MESSAGE_ID)).toBeNull();
  });

  it("persists and hydrates text, images, and uploaded files", () => {
    const persistedImage = {
      id: "image-1",
      name: "pixel.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
    };
    useQueuedMessageRestoreStore.getState().remember(QUEUED_MESSAGE_ID, {
      prompt: "after this turn",
      images: [],
      persistedImages: [persistedImage],
      files: [
        {
          type: "file",
          id: "file-1",
          name: "report.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          file: new File(["hello"], "report.txt", { type: "text/plain" }),
          uploadedAttachmentId: "attachment-1",
          uploadEnvironmentId: EnvironmentId.make("environment-1"),
        },
      ],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
    });

    const persisted = partializeRestoreStoreState(useQueuedMessageRestoreStore.getState());
    const hydrated = hydratePersistedRestoreStoreState(persisted);
    const snapshot = hydrated.snapshotsByQueuedMessageId[QUEUED_MESSAGE_ID];

    expect(snapshot).toMatchObject({
      prompt: "after this turn",
      images: [{ id: "image-1", previewUrl: persistedImage.dataUrl }],
      files: [
        {
          id: "file-1",
          file: null,
          uploadedAttachmentId: "attachment-1",
          uploadEnvironmentId: "environment-1",
        },
      ],
    });
    expect(snapshot?.persistedImages).toEqual([persistedImage]);
  });

  it("drops malformed persisted snapshots instead of hydrating unsafe state", () => {
    expect(
      normalizePersistedRestoreStoreState({
        snapshotsByQueuedMessageId: { "queued-1": { prompt: 42 } },
      }),
    ).toEqual({ snapshotsByQueuedMessageId: {} });
  });
});

describe("legacy localStorage queue", () => {
  let storage = createMemoryStorage();
  beforeEach(() => {
    storage = createMemoryStorage();
  });

  it("hands a pre-server queue back once and forgets it", () => {
    storage.setItem(
      "t3code:queued-composer-messages:v1",
      JSON.stringify({
        version: 1,
        state: {
          queuesByThreadKey: {
            "thread-a": [{ id: "old-1", prompt: "never sent" }],
            "thread-b": [{ id: "old-2", prompt: "other thread" }],
          },
        },
      }),
    );

    expect(takeLegacyQueuedMessages("thread-a", storage).map((entry) => entry.prompt)).toEqual([
      "never sent",
    ]);
    expect(takeLegacyQueuedMessages("thread-a", storage)).toEqual([]);
    // Another thread's queue survives until that thread is opened.
    expect(takeLegacyQueuedMessages("thread-b", storage).map((entry) => entry.prompt)).toEqual([
      "other thread",
    ]);
    expect(storage.getItem("t3code:queued-composer-messages:v1")).toBeNull();
  });

  it("tolerates a missing or unparseable key", () => {
    expect(takeLegacyQueuedMessages("thread-a", storage)).toEqual([]);
    storage.setItem("t3code:queued-composer-messages:v1", "{not json");
    expect(takeLegacyQueuedMessages("thread-a", storage)).toEqual([]);
  });
});

describe("queued message boundary anchor", () => {
  const activities = [
    { id: "a1", kind: "tool.started", sequence: 1, createdAt: "2026-01-01T00:00:01Z" },
    { id: "a2", kind: "tool.completed", sequence: 2, createdAt: "2026-01-01T00:00:02Z" },
    { id: "a3", kind: "tool.updated", sequence: 3, createdAt: "2026-01-01T00:00:03Z" },
  ];

  it("finds the newest completed tool call by sequence, not position", () => {
    expect(latestCompletedToolActivityId(activities)).toBe("a2");
    expect(latestCompletedToolActivityId([])).toBeNull();
    expect(
      latestCompletedToolActivityId([
        { id: "late", kind: "tool.completed", sequence: 9, createdAt: "2026-01-01T00:00:09Z" },
        { id: "early", kind: "tool.completed", sequence: 4, createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toBe("late");
  });
});
