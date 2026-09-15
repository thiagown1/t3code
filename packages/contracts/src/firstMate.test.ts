import {
  CommandId,
  FirstMateCommand,
  FirstMateDecision,
  FirstMateEvent,
  FirstMateMachineAlertSummary,
  FirstMateTopicId,
  ProjectId,
  ThreadId,
} from "./index.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const decodeCommand = Schema.decodeUnknownSync(FirstMateCommand);
const decodeDecision = Schema.decodeUnknownSync(FirstMateDecision);
const decodeEvent = Schema.decodeUnknownSync(FirstMateEvent);
const decodeMachineAlerts = Schema.decodeUnknownSync(FirstMateMachineAlertSummary);

describe("FirstMate contracts", () => {
  it("decodes a provider-agnostic topic command", () => {
    const command = decodeCommand({
      type: "firstmate.topic.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      topicId: FirstMateTopicId.make("topic-1"),
      title: "Machine monitoring",
      summary: "Surface connected environment pressure.",
      stage: "implementation",
      threadId: ThreadId.make("thread-1"),
      responsibleAgentId: "agent-1",
      createdAt: "2026-09-14T20:00:00.000Z",
    });

    expect(command).toMatchObject({
      type: "firstmate.topic.create",
      stage: "implementation",
      responsibleAgentId: "agent-1",
    });
  });

  it("rejects negative machine alert counts", () => {
    expect(() =>
      decodeMachineAlerts({
        informational: 0,
        attention: -1,
        critical: 0,
      }),
    ).toThrow();
  });

  it("rejects topic updates that carry no change", () => {
    expect(() =>
      decodeCommand({
        type: "firstmate.topic.update",
        commandId: CommandId.make("command-2"),
        projectId: ProjectId.make("project-1"),
        topicId: FirstMateTopicId.make("topic-1"),
        createdAt: "2026-09-14T20:00:00.000Z",
      }),
    ).toThrow();
  });

  it("decodes persisted decisions created before selected options were recorded", () => {
    const decision = decodeDecision({
      id: "decision-1",
      projectId: "project-1",
      topicId: "topic-1",
      source: { kind: "firstmate", sourceId: "routing" },
      question: "Deploy behind a feature flag?",
      options: [{ id: "yes", label: "Yes", description: "Keep activation separate." }],
      recommendedOptionId: "yes",
      blocking: true,
      status: "resolved",
      createdAt: "2026-09-14T20:00:00.000Z",
      updatedAt: "2026-09-14T21:00:00.000Z",
      resolvedAt: "2026-09-14T21:00:00.000Z",
    });

    expect(decision.selectedOptionId).toBeNull();
  });

  it("decodes historical resolution events without a selected option", () => {
    const event = decodeEvent({
      type: "firstmate.decision-resolved",
      projectId: "project-1",
      decisionId: "decision-1",
      occurredAt: "2026-09-14T21:00:00.000Z",
    });

    expect(event).toMatchObject({ type: "firstmate.decision-resolved", selectedOptionId: null });
  });
});
