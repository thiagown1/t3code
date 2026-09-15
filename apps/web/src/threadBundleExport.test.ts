import type { MessageId, ProjectId, ThreadBundle, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadBundleReviewMessage,
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
});
