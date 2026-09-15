import {
  CommandId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ThreadId,
  type FirstMateCommand,
  type FirstMateTopic,
  type FirstMateTopicRuntimeFacts,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createEmptyFirstMateWorkspace,
  decideFirstMateCommand,
  deriveFirstMateTopicReadModel,
  deriveFirstMateTopicStatus,
  replayFirstMateEvents,
} from "./firstMate.ts";

const projectId = ProjectId.make("project-1");
const topicId = FirstMateTopicId.make("topic-1");
const decisionId = FirstMateDecisionId.make("decision-1");

type WithoutCommandBase<Value> = Value extends FirstMateCommand
  ? Omit<Value, "commandId" | "projectId" | "createdAt"> & { readonly createdAt?: string }
  : never;

function command(value: WithoutCommandBase<FirstMateCommand>): FirstMateCommand {
  return {
    ...value,
    commandId: CommandId.make(`command-${value.type}`),
    projectId,
    createdAt: value.createdAt ?? "2026-09-14T20:00:00.000Z",
  } as FirstMateCommand;
}

function accept(state: ReturnType<typeof createEmptyFirstMateWorkspace>, value: FirstMateCommand) {
  const result = decideFirstMateCommand(state, value);
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  return replayFirstMateEvents(state, result.events);
}

function topicCreate(): FirstMateCommand {
  return command({
    type: "firstmate.topic.create",
    topicId,
    title: "Machine monitoring",
    summary: "Show capacity across connected environments.",
    stage: "implementation",
    threadId: ThreadId.make("thread-1"),
    responsibleAgentId: "agent-1",
  });
}

describe("FirstMate domain", () => {
  it("creates and updates one topic in place during replay", () => {
    let state = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    state = accept(state, topicCreate());
    state = accept(
      state,
      command({
        type: "firstmate.topic.update",
        topicId,
        summary: "Monitoring implementation is ready for validation.",
        stage: "completed",
        createdAt: "2026-09-14T21:00:00.000Z",
      }),
    );

    expect(state.topics).toHaveLength(1);
    expect(state.topics[0]).toMatchObject({
      id: topicId,
      summary: "Monitoring implementation is ready for validation.",
      stage: "completed",
      completedAt: "2026-09-14T21:00:00.000Z",
    });
  });

  it("rejects duplicate topics and commands for missing topics", () => {
    const empty = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    const state = accept(empty, topicCreate());

    expect(decideFirstMateCommand(state, topicCreate())).toEqual({
      accepted: false,
      reason: "topic-already-exists",
    });
    expect(
      decideFirstMateCommand(
        empty,
        command({
          type: "firstmate.topic.delegate",
          topicId,
          threadId: null,
          responsibleAgentId: null,
        }),
      ),
    ).toEqual({ accepted: false, reason: "topic-not-found" });
  });

  it("keeps a decision pinned until it is explicitly resolved", () => {
    let state = accept(
      createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z"),
      topicCreate(),
    );
    state = accept(
      state,
      command({
        type: "firstmate.decision.open",
        decisionId,
        topicId,
        source: { kind: "firstmate", sourceId: "routing-choice" },
        question: "Deploy behind a feature flag?",
        options: [
          { id: "yes", label: "Yes", description: "Keep activation separate." },
          { id: "no", label: "No", description: "Release directly." },
        ],
        recommendedOptionId: "yes",
        blocking: true,
      }),
    );

    expect(state.decisions[0]?.status).toBe("pending");
    state = accept(
      state,
      command({
        type: "firstmate.decision.resolve",
        decisionId,
        selectedOptionId: "yes",
        createdAt: "2026-09-14T22:00:00.000Z",
      }),
    );
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      status: "resolved",
      selectedOptionId: "yes",
      resolvedAt: "2026-09-14T22:00:00.000Z",
    });
  });

  it("rejects a resolution that is not one of the persisted options", () => {
    let state = accept(
      createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z"),
      topicCreate(),
    );
    state = accept(
      state,
      command({
        type: "firstmate.decision.open",
        decisionId,
        topicId,
        source: { kind: "firstmate", sourceId: "routing-choice" },
        question: "Deploy behind a feature flag?",
        options: [{ id: "yes", label: "Yes", description: "Keep activation separate." }],
        recommendedOptionId: "yes",
        blocking: true,
      }),
    );

    expect(
      decideFirstMateCommand(
        state,
        command({
          type: "firstmate.decision.resolve",
          decisionId,
          selectedOptionId: "unknown",
        }),
      ),
    ).toEqual({ accepted: false, reason: "decision-option-not-found" });
  });
});

const baseTopic: FirstMateTopic = {
  id: topicId,
  projectId,
  title: "Deploy monitoring",
  summary: "Validate the production release.",
  stage: "completed",
  threadId: ThreadId.make("thread-1"),
  responsibleAgentId: "agent-1",
  createdAt: "2026-09-14T19:00:00.000Z",
  updatedAt: "2026-09-14T20:00:00.000Z",
  completedAt: "2026-09-14T20:00:00.000Z",
};

const baseFacts: FirstMateTopicRuntimeFacts = {
  sessionStatus: "ready",
  pendingUserInputCount: 0,
  pendingApprovalCount: 0,
  pendingFirstMateDecisionCount: 0,
  backgroundLiveness: null,
  deliveryStatus: null,
  machineAlerts: { informational: 0, attention: 1, critical: 0 },
};

describe("FirstMate topic read model", () => {
  it("derives delivery and user waits instead of persisting another status", () => {
    expect(
      deriveFirstMateTopicStatus(baseTopic, {
        ...baseFacts,
        deliveryStatus: "waiting-deploy",
      }),
    ).toBe("waiting-deploy");
    expect(
      deriveFirstMateTopicStatus(baseTopic, {
        ...baseFacts,
        deliveryStatus: "waiting-deploy",
        pendingUserInputCount: 1,
      }),
    ).toBe("waiting-user");
  });

  it("aggregates machine alerts without turning monitoring into remediation", () => {
    expect(deriveFirstMateTopicReadModel(baseTopic, baseFacts)).toMatchObject({
      operationalStatus: "completed",
      pendingDecisionCount: 0,
      machineAlerts: { informational: 0, attention: 1, critical: 0 },
    });
  });

  it("marks a failed or interrupted execution as blocked", () => {
    expect(
      deriveFirstMateTopicStatus(
        { ...baseTopic, stage: "testing", completedAt: null },
        { ...baseFacts, sessionStatus: "error" },
      ),
    ).toBe("blocked");
  });

  it("keeps background monitoring visible after the provider turn settles", () => {
    expect(
      deriveFirstMateTopicStatus(baseTopic, {
        ...baseFacts,
        backgroundLiveness: "monitoring",
      }),
    ).toBe("monitoring");
  });
});
