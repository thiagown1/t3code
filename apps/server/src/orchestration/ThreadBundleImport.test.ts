import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ThreadBundle,
  type ThreadBundleImportPlan,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadBundleImportCommand,
  threadBundleImportPlansMatch,
} from "./ThreadBundleImport.ts";

const bundle = {
  schemaVersion: 1,
  bundleId: "bundle-1",
  exportedAt: "2026-09-15T20:00:00.000Z",
  threads: [
    {
      sourceEnvironmentId: "desk-a",
      sourceThreadId: ThreadId.make("source-thread"),
      project: { sourceProjectId: ProjectId.make("source-project"), title: "Project" },
      title: "Imported conversation",
      preferredModel: { providerInstanceRef: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      messages: [
        {
          sourceMessageId: MessageId.make("source-message"),
          role: "system",
          text: "Imported context",
          attachments: [],
          createdAt: "2026-09-15T19:00:00.000Z",
          updatedAt: "2026-09-15T19:01:00.000Z",
        },
      ],
      proposedPlans: [
        {
          sourcePlanId: "source-plan",
          planMarkdown: "Implement safely",
          implementedAt: null,
          createdAt: "2026-09-15T19:02:00.000Z",
          updatedAt: "2026-09-15T19:03:00.000Z",
        },
      ],
      resolvedDecisions: [
        {
          sourceDecisionId: "source-decision",
          question: "Proceed?",
          options: [{ id: "yes", label: "Yes", description: "Proceed safely" }],
          recommendedOptionId: "yes",
          selectedOptionId: "yes",
          blocking: true,
          resolvedAt: "2026-09-15T19:04:00.000Z",
        },
      ],
      omissions: [{ kind: "session", count: 1 }],
      createdAt: "2026-09-15T18:00:00.000Z",
      updatedAt: "2026-09-15T19:04:00.000Z",
    },
  ],
} satisfies ThreadBundle;

const plan = {
  bundleId: "bundle-1",
  canImport: true,
  items: [
    {
      sourceEnvironmentId: "desk-a",
      sourceThreadId: ThreadId.make("source-thread"),
      targetThreadId: ThreadId.make("bundle:desk-a:source-thread"),
      title: "Imported conversation",
      status: "ready",
      targetProjectId: ProjectId.make("target-project"),
      messageCount: 1,
      attachmentReferenceCount: 0,
      proposedPlanCount: 1,
      resolvedDecisionCount: 1,
      omissionCount: 1,
    },
  ],
} satisfies ThreadBundleImportPlan;

describe("Thread Bundle atomic import command", () => {
  it("maps portable state to deterministic target identities", () => {
    const command = buildThreadBundleImportCommand({
      bundle,
      plan,
      commandId: CommandId.make("command-import"),
    });

    expect(command).toMatchObject({
      type: "thread.bundle.import",
      threadId: "bundle:desk-a:source-thread",
      entries: [
        {
          targetThreadId: "bundle:desk-a:source-thread",
          projectId: "target-project",
          messages: [
            {
              messageId: "bundle-message:desk-a:source-thread:source-message",
              role: "system",
              updatedAt: "2026-09-15T19:01:00.000Z",
            },
          ],
          proposedPlans: [{ id: "bundle-plan:desk-a:source-thread:source-plan" }],
          resolvedDecisions: [
            {
              topicId: "bundle-topic:desk-a:source-thread",
              decisionId: "bundle-decision:desk-a:source-thread:source-decision",
            },
          ],
        },
      ],
    });
  });

  it("rejects blocked or stale plans before dispatch", () => {
    expect(() =>
      buildThreadBundleImportCommand({
        bundle,
        plan: { ...plan, canImport: false },
        commandId: CommandId.make("command-blocked"),
      }),
    ).toThrow("not ready");
    expect(threadBundleImportPlansMatch(plan, { ...plan, canImport: false })).toBe(false);
  });
});
