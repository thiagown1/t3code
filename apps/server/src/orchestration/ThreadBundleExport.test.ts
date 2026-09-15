import type {
  FirstMateDecision,
  OrchestrationProjectShell,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { exportThreadBundleFromProjection } from "./ThreadBundleExport.ts";

const NOW = "2026-09-15T18:15:00.000Z";
const THREAD_ID = "thread-one" as ThreadId;
const PROJECT_ID = "project-one" as ProjectId;

function thread(): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Portable thread",
    modelSelection: { instanceId: "codex", model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    messages: [
      {
        id: "message-one",
        role: "user",
        text: "Portable content",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as OrchestrationThread;
}

function project(): OrchestrationProjectShell {
  const decisions = [
    {
      id: "decision-linked",
      projectId: PROJECT_ID,
      topicId: "topic-linked",
      source: { kind: "firstmate", sourceId: "internal-source" },
      question: "Continue?",
      options: [{ id: "yes", label: "Yes", description: "Continue" }],
      recommendedOptionId: "yes",
      selectedOptionId: "yes",
      blocking: false,
      status: "resolved",
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: NOW,
    },
    {
      id: "decision-other-thread",
      projectId: PROJECT_ID,
      topicId: "topic-other",
      source: { kind: "firstmate", sourceId: "other-source" },
      question: "Other?",
      options: [{ id: "no", label: "No", description: "Stop" }],
      recommendedOptionId: null,
      selectedOptionId: "no",
      blocking: false,
      status: "resolved",
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: NOW,
    },
  ] as unknown as ReadonlyArray<FirstMateDecision>;
  return {
    id: PROJECT_ID,
    title: "Project",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/project",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://credential-secret@github.com/acme/project.git",
      },
    },
    firstMate: {
      projectId: PROJECT_ID,
      supervisorThreadId: null,
      selectedTopicId: null,
      topics: [
        {
          id: "topic-linked",
          projectId: PROJECT_ID,
          title: "Linked",
          summary: "Linked",
          stage: "completed",
          threadId: THREAD_ID,
          responsibleAgentId: null,
          createdAt: NOW,
          updatedAt: NOW,
          completedAt: NOW,
        },
        {
          id: "topic-other",
          projectId: PROJECT_ID,
          title: "Other",
          summary: "Other",
          stage: "completed",
          threadId: "thread-other",
          responsibleAgentId: null,
          createdAt: NOW,
          updatedAt: NOW,
          completedAt: NOW,
        },
      ],
      decisions,
      routingReceipts: [],
      routingEvaluationMode: "off",
      updatedAt: NOW,
    },
  } as unknown as OrchestrationProjectShell;
}

function projection(
  options: { readonly missingThread?: boolean; readonly missingProject?: boolean } = {},
) {
  return {
    getThreadDetailSnapshot: () =>
      Effect.succeed(
        options.missingThread
          ? Option.none()
          : Option.some({ snapshotSequence: 1, thread: thread() }),
      ),
    getProjectShellById: () =>
      Effect.succeed(options.missingProject ? Option.none() : Option.some(project())),
  } as unknown as Pick<
    ProjectionSnapshotQueryShape,
    "getThreadDetailSnapshot" | "getProjectShellById"
  >;
}

describe("Thread Bundle export", () => {
  it("reads selected snapshots and includes only decisions linked to that thread", async () => {
    const bundle = await Effect.runPromise(
      exportThreadBundleFromProjection(
        {
          threadIds: [THREAD_ID],
          sourceEnvironmentId: "desk-source",
          bundleId: "bundle-one",
          exportedAt: NOW,
        },
        projection(),
      ),
    );

    expect(bundle.threads).toHaveLength(1);
    expect(
      bundle.threads[0]?.resolvedDecisions.map((decision) => decision.sourceDecisionId),
    ).toEqual(["decision-linked"]);
    expect(JSON.stringify(bundle)).not.toMatch(/credential-secret|internal-source|other-source/);
  });

  it("fails closed for duplicate, missing thread, and missing project selections", async () => {
    const base = {
      sourceEnvironmentId: "desk-source",
      bundleId: "bundle-one",
      exportedAt: NOW,
    };
    const duplicate = await Effect.runPromise(
      Effect.flip(
        exportThreadBundleFromProjection(
          { ...base, threadIds: [THREAD_ID, THREAD_ID] },
          projection(),
        ),
      ),
    );
    expect(duplicate.reason).toBe("duplicate-thread");

    const missingThread = await Effect.runPromise(
      Effect.flip(
        exportThreadBundleFromProjection(
          { ...base, threadIds: [THREAD_ID] },
          projection({ missingThread: true }),
        ),
      ),
    );
    expect(missingThread).toMatchObject({ reason: "thread-not-found", threadId: THREAD_ID });

    const missingProject = await Effect.runPromise(
      Effect.flip(
        exportThreadBundleFromProjection(
          { ...base, threadIds: [THREAD_ID] },
          projection({ missingProject: true }),
        ),
      ),
    );
    expect(missingProject).toMatchObject({ reason: "project-not-found", threadId: THREAD_ID });
  });
});
