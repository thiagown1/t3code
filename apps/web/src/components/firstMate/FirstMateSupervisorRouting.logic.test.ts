import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planFirstMateSupervisorSubmission } from "./FirstMateSupervisorRouting.logic";

const now = "2026-09-14T20:00:00.000Z";
const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const supervisorThreadId = ThreadId.make("supervisor");
const delegatedThreadId = ThreadId.make("delegated");
const topicId = FirstMateTopicId.make("topic-1");

const delegatedThread: EnvironmentThreadShell = {
  environmentId,
  id: delegatedThreadId,
  projectId,
  title: "Implement routing",
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

const project: EnvironmentProject = {
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
    supervisorThreadId,
    selectedTopicId: topicId,
    topics: [
      {
        id: topicId,
        projectId,
        title: "Routing",
        summary: "Route supervisor messages.",
        stage: "implementation",
        threadId: delegatedThreadId,
        responsibleAgentId: "firstmate",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
    ],
    decisions: [],
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

describe("planFirstMateSupervisorSubmission", () => {
  it("routes a plain supervisor message to an existing delegated thread", () => {
    expect(
      planFirstMateSupervisorSubmission({
        project,
        activeThreadId: supervisorThreadId,
        threads: [delegatedThread],
        message: "Continue the implementation.",
        hasComposerContext: false,
      }),
    ).toEqual({
      status: "routed",
      reason: "selected-topic",
      topicId,
      target: delegatedThread,
      threadId: delegatedThreadId,
      message: "Continue the implementation.",
    });
  });

  it("does not intercept an ordinary project thread", () => {
    expect(
      planFirstMateSupervisorSubmission({
        project,
        activeThreadId: delegatedThreadId,
        threads: [delegatedThread],
        message: "Continue.",
        hasComposerContext: false,
      }),
    ).toEqual({ status: "passthrough" });
  });

  it("fails closed for context-bearing messages and missing destination shells", () => {
    expect(
      planFirstMateSupervisorSubmission({
        project,
        activeThreadId: supervisorThreadId,
        threads: [delegatedThread],
        message: "Inspect this image.",
        hasComposerContext: true,
      }),
    ).toMatchObject({
      status: "needs-confirmation",
      reason: "composer-context-not-supported",
      candidateTopicIds: [topicId],
    });

    expect(
      planFirstMateSupervisorSubmission({
        project,
        activeThreadId: supervisorThreadId,
        threads: [],
        message: "Continue.",
        hasComposerContext: false,
      }),
    ).toMatchObject({
      status: "needs-confirmation",
      reason: "destination-thread-not-found",
      candidateTopicIds: [topicId],
    });
  });
});
