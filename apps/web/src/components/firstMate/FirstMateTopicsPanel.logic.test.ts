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

import { buildFirstMatePanelModel } from "./FirstMateTopicsPanel.logic";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const topicId = FirstMateTopicId.make("topic-1");
const now = "2026-09-14T20:00:00.000Z";

function project(firstMate: EnvironmentProject["firstMate"]): EnvironmentProject {
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
    ...(firstMate === undefined ? {} : { firstMate }),
    createdAt: now,
    updatedAt: now,
  };
}

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId,
    id: threadId,
    projectId,
    title: "Implement FirstMate",
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
    ...overrides,
  };
}

const workspace: NonNullable<EnvironmentProject["firstMate"]> = {
  projectId,
  supervisorThreadId: null,
  selectedTopicId: null,
  topics: [
    {
      id: topicId,
      projectId,
      title: "FirstMate panel",
      summary: "Show durable topics in place.",
      stage: "completed",
      threadId,
      responsibleAgentId: "firstmate",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    },
  ],
  decisions: [],
  updatedAt: now,
};

describe("FirstMate topics panel model", () => {
  it("distinguishes unavailable environments from an empty workspace", () => {
    expect(
      buildFirstMatePanelModel({
        projects: [project(undefined)],
        threads: [],
        scopedProjectKeys: null,
      }).availability,
    ).toBe("unavailable");
    expect(
      buildFirstMatePanelModel({
        projects: [project(null)],
        threads: [],
        scopedProjectKeys: null,
      }).availability,
    ).toBe("empty");
  });

  it("derives waiting deploy from the linked thread without persisting another status", () => {
    const model = buildFirstMatePanelModel({
      projects: [project({ ...workspace, selectedTopicId: topicId })],
      threads: [thread({ deliveryStatus: "waiting-deploy" })],
      scopedProjectKeys: null,
    });

    expect(model.items[0]).toMatchObject({
      status: "waiting-deploy",
      selected: true,
      threadId,
      pendingDecisionCount: 0,
    });
  });

  it("prioritizes a pending FirstMate decision over delivery status", () => {
    const model = buildFirstMatePanelModel({
      projects: [
        project({
          ...workspace,
          decisions: [
            {
              id: FirstMateDecisionId.make("decision-1"),
              projectId,
              topicId,
              source: { kind: "firstmate", sourceId: "routing" },
              question: "Deploy now?",
              options: [],
              recommendedOptionId: null,
              selectedOptionId: null,
              blocking: true,
              status: "pending",
              createdAt: now,
              updatedAt: now,
              resolvedAt: null,
            },
          ],
        }),
      ],
      threads: [thread({ deliveryStatus: "waiting-deploy" })],
      scopedProjectKeys: null,
    });

    expect(model.items[0]).toMatchObject({ status: "waiting-user", pendingDecisionCount: 1 });
  });

  it("filters topics by the active project scope", () => {
    const model = buildFirstMatePanelModel({
      projects: [project(workspace)],
      threads: [thread()],
      scopedProjectKeys: new Set([`${environmentId}:another-project`]),
    });

    expect(model).toMatchObject({ availability: "unavailable", projectCount: 0, items: [] });
  });
});
