import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFirstMateChatDecisionFeed } from "./FirstMateDecisionFeed.logic";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const topicId = FirstMateTopicId.make("topic-1");
const workerThreadId = ThreadId.make("thread-worker");
const supervisorThreadId = ThreadId.make("thread-supervisor");
const now = "2026-09-14T20:00:00.000Z";

function decision(id: string, blocking: boolean) {
  return {
    id: FirstMateDecisionId.make(id),
    projectId,
    topicId,
    source: { kind: "firstmate" as const, sourceId: "supervisor" },
    question: `Choose ${id}`,
    options: [
      { id: "recommended", label: "Recommended", description: "Use the safer path." },
      { id: "direct", label: "Direct", description: "Use the shorter path." },
    ],
    recommendedOptionId: "recommended",
    selectedOptionId: null,
    blocking,
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  };
}

function project(supervisor: ThreadId | null): EnvironmentProject {
  return {
    environmentId,
    id: projectId,
    title: "T3 Code",
    workspaceRoot: "/tmp/t3code",
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    firstMate: {
      projectId,
      supervisorThreadId: supervisor,
      selectedTopicId: null,
      topics: [
        {
          id: topicId,
          projectId,
          title: "Rate limits",
          summary: "Decide how auth rate limits behave.",
          stage: "planning",
          threadId: workerThreadId,
          responsibleAgentId: "codex",
          latestRoundSummary: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
      ],
      decisions: [decision("advisory", false), decision("blocking", true)],
      routingReceipts: [],
      routingEvaluationMode: "off",
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function thread(id: ThreadId, title: string): EnvironmentThreadShell {
  return {
    environmentId,
    id,
    projectId,
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const threads = [thread(workerThreadId, "Rate limits"), thread(supervisorThreadId, "Planning")];

describe("FirstMate chat decision feed", () => {
  it("shows the project's pending decisions in the supervisor thread, blocking first", () => {
    const feed = buildFirstMateChatDecisionFeed({
      project: project(supervisorThreadId),
      threads,
      activeThreadId: supervisorThreadId,
    });

    expect(feed.isSupervisorThread).toBe(true);
    expect(feed.items.map((item) => item.decisionId)).toEqual(["blocking", "advisory"]);
    expect(feed.items[0]).toMatchObject({ topicTitle: "Rate limits", threadId: workerThreadId });
  });

  it("stays empty in a worker thread of the same project", () => {
    const feed = buildFirstMateChatDecisionFeed({
      project: project(supervisorThreadId),
      threads,
      activeThreadId: workerThreadId,
    });

    expect(feed).toEqual({ isSupervisorThread: false, items: [] });
  });

  it("stays empty while the project has no supervisor linked", () => {
    const feed = buildFirstMateChatDecisionFeed({
      project: project(null),
      threads,
      activeThreadId: supervisorThreadId,
    });

    expect(feed).toEqual({ isSupervisorThread: false, items: [] });
  });
});
