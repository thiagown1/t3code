import type {
  EnvironmentId,
  MessageId,
  ProjectId,
  ScopedThreadRef,
  ThreadBundle,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadBundleReviewMessage,
  combineThreadBundleExports,
  planThreadBundleExportRequests,
  summarizeThreadBundle,
  threadBundleDownloadName,
} from "./threadBundleExport";

const bundle: ThreadBundle = {
  schemaVersion: 1,
  bundleId: "bundle-1",
  exportedAt: "2026-09-15T12:34:56.000Z",
  threads: [
    {
      sourceEnvironmentId: "environment-1",
      sourceThreadId: "thread-1" as ThreadId,
      project: { sourceProjectId: "project-1" as ProjectId, title: "T3 Code" },
      title: "Conversa de implantação / produção",
      preferredModel: { providerInstanceRef: "codex", model: "gpt-5.6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feat/export",
      messages: [
        {
          sourceMessageId: "message-1" as MessageId,
          role: "user",
          text: "Export this conversation",
          attachments: [
            {
              sourceAttachmentId: "attachment-1",
              type: "image",
              name: "screen.png",
              mimeType: "image/png",
              sizeBytes: 42,
              availability: "reference-only",
            },
          ],
          createdAt: "2026-09-15T12:00:00.000Z",
          updatedAt: "2026-09-15T12:00:00.000Z",
        },
      ],
      proposedPlans: [],
      resolvedDecisions: [],
      omissions: [
        { kind: "session", count: 1 },
        { kind: "attachment-content", count: 1 },
      ],
      createdAt: "2026-09-15T12:00:00.000Z",
      updatedAt: "2026-09-15T12:30:00.000Z",
    },
  ],
};

describe("Thread Bundle export review", () => {
  it("summarizes portable content and omitted state before download", () => {
    expect(summarizeThreadBundle(bundle)).toEqual({
      threadCount: 1,
      messageCount: 1,
      attachmentReferenceCount: 1,
      proposedPlanCount: 0,
      resolvedDecisionCount: 0,
      omissionCount: 2,
      omissions: [
        { kind: "attachment-content", count: 1 },
        { kind: "session", count: 1 },
      ],
    });

    const message = buildThreadBundleReviewMessage(bundle);
    expect(message).toContain("1 completed message");
    expect(message).toContain("1 attachment reference (file contents are not included)");
    expect(message).toContain("1 runtime session");
    expect(message).toContain("Review the JSON before sharing it");
  });

  it("creates a stable filesystem-safe download name", () => {
    expect(threadBundleDownloadName(bundle)).toBe(
      "t3-thread-bundle-conversa-de-implantacao-producao-2026-09-15T12-34-56-000Z.json",
    );
  });

  it("groups a selection by environment without losing its total limit", () => {
    const requests = planThreadBundleExportRequests([
      { environmentId: "environment-1" as EnvironmentId, threadId: "thread-1" as ThreadId },
      { environmentId: "environment-2" as EnvironmentId, threadId: "thread-2" as ThreadId },
      { environmentId: "environment-1" as EnvironmentId, threadId: "thread-3" as ThreadId },
    ] satisfies ReadonlyArray<ScopedThreadRef>);

    expect(requests).toEqual([
      {
        environmentId: "environment-1",
        input: { threadIds: ["thread-1", "thread-3"] },
      },
      { environmentId: "environment-2", input: { threadIds: ["thread-2"] } },
    ]);
    expect(() => planThreadBundleExportRequests([])).toThrow("at least one thread");
    expect(() =>
      planThreadBundleExportRequests(
        Array.from({ length: 51 }, (_, index) => ({
          environmentId: "environment-1" as EnvironmentId,
          threadId: `thread-${index}` as ThreadId,
        })),
      ),
    ).toThrow("at most 50 threads");
  });

  it("combines sanitized exports from multiple environments into one canonical bundle", () => {
    const secondBundle: ThreadBundle = {
      ...bundle,
      bundleId: "bundle-2",
      exportedAt: "2026-09-15T12:35:00.000Z",
      threads: [
        {
          ...bundle.threads[0]!,
          sourceEnvironmentId: "environment-2",
          sourceThreadId: "thread-2" as ThreadId,
          title: "Second conversation",
        },
      ],
    };

    const combined = combineThreadBundleExports([bundle, secondBundle]);
    expect(combined).toMatchObject({
      schemaVersion: 1,
      bundleId: "bundle-1",
      exportedAt: "2026-09-15T12:35:00.000Z",
    });
    expect(combined.threads.map((thread) => thread.sourceEnvironmentId)).toEqual([
      "environment-1",
      "environment-2",
    ]);
  });
});
