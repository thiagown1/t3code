import {
  ProjectId,
  ThreadId,
  type ThreadBundleImportPlan,
  type ThreadBundleImportStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  summarizeThreadBundleImportPlan,
  threadBundleImportStatusLabel,
} from "./ThreadBundleSettings.logic";

describe("Thread Bundle import review", () => {
  it("labels every fail-closed dry-run status", () => {
    const statuses: ThreadBundleImportStatus[] = [
      "ready",
      "duplicate",
      "missing-project",
      "ambiguous-project",
      "missing-provider",
    ];

    expect(statuses.map(threadBundleImportStatusLabel)).toEqual([
      "Ready",
      "Already imported",
      "Project not found",
      "Multiple matching projects",
      "Provider unavailable",
    ]);
  });

  it("summarizes portable content and omissions without treating blocked items as ready", () => {
    const plan = {
      bundleId: "bundle-1",
      canImport: false,
      items: [
        {
          sourceEnvironmentId: "desk-a",
          sourceThreadId: ThreadId.make("thread-a"),
          targetThreadId: ThreadId.make("bundle:desk-a:thread-a"),
          title: "Ready thread",
          status: "ready",
          targetProjectId: ProjectId.make("project-a"),
          messageCount: 3,
          attachmentReferenceCount: 2,
          proposedPlanCount: 1,
          resolvedDecisionCount: 1,
          omissionCount: 4,
        },
        {
          sourceEnvironmentId: "desk-b",
          sourceThreadId: ThreadId.make("thread-b"),
          targetThreadId: ThreadId.make("bundle:desk-b:thread-b"),
          title: "Blocked thread",
          status: "missing-project",
          targetProjectId: null,
          messageCount: 5,
          attachmentReferenceCount: 0,
          proposedPlanCount: 2,
          resolvedDecisionCount: 0,
          omissionCount: 3,
        },
      ],
    } satisfies ThreadBundleImportPlan;

    expect(summarizeThreadBundleImportPlan(plan)).toEqual({
      threads: 2,
      readyThreads: 1,
      messages: 8,
      attachmentReferences: 2,
      plans: 3,
      decisions: 1,
      omissions: 7,
    });
  });
});
