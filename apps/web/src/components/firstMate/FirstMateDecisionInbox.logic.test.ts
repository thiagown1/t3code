import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  ApprovalRequestId,
  EnvironmentId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
  topics?: NonNullable<EnvironmentProject["firstMate"]>["topics"],
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
      topics: topics ?? [
        {
          id: topicId,
          projectId,
          title: "FirstMate inbox",
          summary: "Collect decisions across topics.",
          stage: "implementation",
          threadId,
          responsibleAgentId: "firstmate",
          latestRoundSummary: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
      ],
      decisions,
      routingReceipts: [],
      routingEvaluationMode: "off",
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

/** A card the request reactor lifted out of a thread, owned by a topic or not. */
function requestDecision(
  id: string,
  owningTopicId: typeof topicId | null,
  sourceThreadId: ThreadId = threadId,
) {
  return {
    ...decision(id, true),
    topicId: owningTopicId,
    source: {
      kind: "approval" as const,
      requestId: ApprovalRequestId.make(`request-${id}`),
      threadId: sourceThreadId,
    },
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
      originKind: "topic",
      originTitle: "FirstMate inbox",
      threadId,
      responsibleAgentId: "firstmate",
    });
  });

  it("names the asking thread when no topic owns the card", () => {
    const model = buildFirstMateDecisionInboxModel({
      projects: [project([requestDecision("unowned", null)], [])],
      threads: [linkedThread],
      scopedProjectKeys: null,
    });

    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      decisionId: "unowned",
      topicId: null,
      originKind: "thread",
      // Without a topic the thread title is the only honest label, and the
      // provider running it is the closest thing to who is asking.
      originTitle: "Implement inbox",
      responsibleAgentId: "codex",
      threadId,
    });
  });

  it("shows a turn review card on the reviewed thread", () => {
    const model = buildFirstMateDecisionInboxModel({
      projects: [
        project(
          [
            {
              ...decision("review", false),
              topicId: null,
              source: { kind: "turn-review" as const, threadId, turnId: TurnId.make("turn-1") },
            },
          ],
          [],
        ),
      ],
      threads: [linkedThread],
      scopedProjectKeys: null,
    });

    expect(model.items).toMatchObject([
      { decisionId: "review", originKind: "thread", originTitle: "Implement inbox", threadId },
    ]);
  });

  it("drops a card whose origin the client cannot name", () => {
    const unknownThread = ThreadId.make("thread-gone");
    const model = buildFirstMateDecisionInboxModel({
      projects: [
        project(
          [
            requestDecision("dangling-topic", topicId),
            requestDecision("dead-thread", null, unknownThread),
          ],
          [],
        ),
      ],
      threads: [linkedThread],
      scopedProjectKeys: null,
    });

    expect(model.items).toEqual([]);
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
