import {
  CommandId,
  FirstMateCommand,
  FirstMateMachineAlertSummary,
  FirstMateTopicId,
  ProjectId,
  ThreadId,
} from "./index.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const decodeCommand = Schema.decodeUnknownSync(FirstMateCommand);
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
});
