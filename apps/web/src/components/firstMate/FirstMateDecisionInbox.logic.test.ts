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

import { buildFirstMateDecisionInboxModel } from "./FirstMateDecisionInbox.logic";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const topicId = FirstMateTopicId.make("topic-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-09-14T20:00:00.000Z";

function project(
  decisions: NonNullable<EnvironmentProject["firstMate"]>["decisions"],
): EnvironmentProject {
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
      supervisorThreadId: null,
      selectedTopicId: null,
      topics: [
        {
          id: topicId,
          projectId,
          title: "FirstMate inbox",
          summary: "Collect decisions across topics.",
          stage: "implementation",
          threadId,
          responsibleAgentId: "firstmate",
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
      ],
      decisions,
      routingReceipts: [],
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

const linkedThread: EnvironmentThreadShell = {
  environmentId,
  id: threadId,
  projectId,
  title: "Implement inbox",
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

function decision(id: string, blocking: boolean, status: "pending" | "resolved" = "pending") {
  return {
    id: FirstMateDecisionId.make(id),
    projectId,
    topicId,
    source: { kind: "firstmate" as const, sourceId: "routing" },
    question: `Choose ${id}`,
    options: [
      { id: "recommended", label: "Recommended", description: "Use the safer path." },
      { id: "direct", label: "Direct", description: "Use the shorter path." },
    ],
    recommendedOptionId: "recommended",
    selectedOptionId: status === "resolved" ? "recommended" : null,
    blocking,
    status,
    createdAt: now,
    updatedAt: now,
    resolvedAt: status === "resolved" ? now : null,
  };
}

describe("FirstMate decision inbox model", () => {
  it("keeps only pending decisions and links them to their topic thread", () => {
    const model = buildFirstMateDecisionInboxModel({
      projects: [project([decision("pending", false), decision("resolved", false, "resolved")])],
      threads: [linkedThread],
      scopedProjectKeys: null,
    });

    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      decisionId: "pending",
      topicTitle: "FirstMate inbox",
      threadId,
      responsibleAgentId: "firstmate",
    });
  });

  it("puts blocking decisions first", () => {
    const model = buildFirstMateDecisionInboxModel({
      projects: [project([decision("advisory", false), decision("blocking", true)])],
      threads: [linkedThread],
      scopedProjectKeys: null,
    });

    expect(model.items.map((item) => item.decisionId)).toEqual(["blocking", "advisory"]);
  });

  it("honors the active project scope", () => {
    const model = buildFirstMateDecisionInboxModel({
      projects: [project([decision("pending", true)])],
      threads: [linkedThread],
      scopedProjectKeys: new Set([`${environmentId}:another-project`]),
    });

    expect(model).toEqual({ projectCount: 0, items: [] });
  });
});
