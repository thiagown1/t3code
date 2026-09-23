import { ComposerContextId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildParallelThreadStartMessage,
  parallelThreadSnapshotIsStale,
  parseParallelThreadCommand,
  readParallelThreadSourceSnapshot,
} from "./parallelThreads";

describe("parallel threads", () => {
  it("parses both command aliases and requires an objective", () => {
    expect(parseParallelThreadCommand("/paralelo investigar o CI")).toEqual({
      objective: "investigar o CI",
    });
    expect(parseParallelThreadCommand("/parallel inspect logs")).toEqual({
      objective: "inspect logs",
    });
    expect(parseParallelThreadCommand("/paralelo")).toEqual({ objective: null });
    expect(parseParallelThreadCommand("normal prompt")).toBeNull();
  });

  it("builds a bounded, auditable snapshot without mutable or binary state", () => {
    const built = buildParallelThreadStartMessage({
      contextId: ComposerContextId.make("parallel_ctx"),
      objective: "Inspect the deployment",
      forkedAt: "2026-09-14T20:00:00.000Z",
      sourceThread: {
        id: ThreadId.make("source-thread"),
        title: "Deploy feature",
        updatedAt: "2026-09-14T19:59:00.000Z",
        messages: [
          {
            id: MessageId.make("system-message"),
            role: "system",
            text: "secret internal state",
            streaming: false,
            createdAt: "2026-09-14T19:57:00.000Z",
          },
          {
            id: MessageId.make("user-message"),
            role: "user",
            text: "Please verify the deploy",
            attachments: [
              {
                name: "screen.png",
                mimeType: "image/png",
                sizeBytes: 123,
              },
            ],
            streaming: false,
            createdAt: "2026-09-14T19:58:00.000Z",
          },
          {
            id: MessageId.make("streaming-message"),
            role: "assistant",
            text: "unfinished",
            streaming: true,
            createdAt: "2026-09-14T19:59:00.000Z",
          },
        ],
      },
      activePlan: null,
    });

    expect(built.text).toContain("Inspect the deployment");
    expect(built.text).toContain("t3-context://v1/parallel-thread/parallel_ctx");
    const record = built.context.records[0];
    expect(record && "payload" in record).toBe(true);
    const payload =
      record && "payload" in record ? (record.payload as Record<string, unknown>) : {};
    expect(payload.messages).toEqual([
      expect.objectContaining({ id: "user-message", text: "Please verify the deploy" }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("secret internal state");
    expect(JSON.stringify(payload)).toContain("screen.png");
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(64_000);
  });

  it("marks the snapshot stale only after the source advances", () => {
    expect(
      parallelThreadSnapshotIsStale("2026-09-14T19:59:00.000Z", "2026-09-14T19:59:00.000Z"),
    ).toBe(false);
    expect(
      parallelThreadSnapshotIsStale("2026-09-14T19:59:00.000Z", "2026-09-14T20:00:00.000Z"),
    ).toBe(true);
  });

  it("bounds an oversized objective inside the structured context", () => {
    const built = buildParallelThreadStartMessage({
      contextId: ComposerContextId.make("parallel_large_objective"),
      objective: "x".repeat(100_000),
      forkedAt: "2026-09-14T20:00:00.000Z",
      sourceThread: {
        id: ThreadId.make("source-thread"),
        title: "Large task",
        updatedAt: "2026-09-14T19:59:00.000Z",
        messages: [],
      },
      activePlan: null,
    });

    const record = built.context.records[0];
    const payload =
      record && "payload" in record ? (record.payload as Record<string, unknown>) : {};
    expect(payload.objectiveTruncated).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(64_000);
  });

  it("recovers the durable source link from the child message context", () => {
    const built = buildParallelThreadStartMessage({
      contextId: ComposerContextId.make("parallel_source_link"),
      objective: "Continue independently",
      forkedAt: "2026-09-14T20:00:00.000Z",
      sourceThread: {
        id: ThreadId.make("source-thread"),
        title: "Original task",
        updatedAt: "2026-09-14T19:59:00.000Z",
        messages: [],
      },
      activePlan: null,
    });

    expect(readParallelThreadSourceSnapshot([{ role: "user", context: built.context }])).toEqual({
      sourceThreadId: "source-thread",
      sourceThreadTitle: "Original task",
      sourceUpdatedAt: "2026-09-14T19:59:00.000Z",
      forkedAt: "2026-09-14T20:00:00.000Z",
      forkPointMessageId: null,
    });
    expect(readParallelThreadSourceSnapshot([{ role: "assistant" }])).toBeNull();
  });
});
