import { MessageId, ProjectId, ThreadId, type ThreadBundle } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadBundleImportPlan, embedThreadBundleAttachments } from "./threadBundle.ts";

const NOW = "2026-09-16T12:00:00.000Z";

function metadataBundle(): ThreadBundle {
  return {
    schemaVersion: 1,
    bundleId: "bundle-integrity",
    exportedAt: NOW,
    threads: [
      {
        sourceEnvironmentId: "source-environment",
        sourceThreadId: ThreadId.make("source-thread"),
        project: {
          sourceProjectId: ProjectId.make("source-project"),
          title: "Source project",
        },
        title: "Imported thread",
        preferredModel: { providerInstanceRef: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        messages: [
          {
            sourceMessageId: MessageId.make("source-message"),
            role: "user",
            text: "Inspect the attachment",
            attachments: [
              {
                sourceAttachmentId: "source-attachment",
                type: "file",
                name: "evidence.txt",
                mimeType: "text/plain",
                sizeBytes: 5,
                availability: "reference-only",
              },
            ],
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        proposedPlans: [],
        resolvedDecisions: [],
        omissions: [{ kind: "attachment-content", count: 1 }],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

describe("Thread Bundle import-plan integrity", () => {
  it("changes the dry-run fingerprint when valid attachment bytes and SHA change", () => {
    const source = metadataBundle();
    const first = embedThreadBundleAttachments(source, () => new TextEncoder().encode("first"));
    const second = embedThreadBundleAttachments(source, () => new TextEncoder().encode("other"));
    const targetProjects = [
      {
        projectId: ProjectId.make("target-project"),
        title: "Target project",
        providerInstanceIds: ["codex"],
      },
    ];

    const firstPlan = buildThreadBundleImportPlan({
      bundle: first,
      targetProjects,
      existingOrigins: [],
    });
    const secondPlan = buildThreadBundleImportPlan({
      bundle: second,
      targetProjects,
      existingOrigins: [],
    });

    expect(firstPlan.items).toEqual(secondPlan.items);
    expect(firstPlan.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(secondPlan.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(secondPlan.bundleSha256).not.toBe(firstPlan.bundleSha256);
  });
});
