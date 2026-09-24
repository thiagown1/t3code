import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FirstMateDecisionId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-09-24T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");

let sequence = 0;

const apply = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const planned = yield* decideOrchestrationCommand({ command, readModel });
    let next = readModel;
    for (const event of Array.isArray(planned) ? planned : [planned]) {
      sequence += 1;
      next = yield* projectEvent(next, {
        ...event,
        sequence,
        eventId: EventId.make(`event-${sequence}`),
      });
    }
    return next;
  });

const createThread = (id: ThreadId) =>
  ({
    type: "thread.create",
    commandId: CommandId.make(`create-${id}`),
    threadId: id,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  }) satisfies OrchestrationCommand;

const openDecision = (
  id: string,
  source: Extract<OrchestrationCommand, { type: "firstmate.decision.open" }>["source"],
) =>
  ({
    type: "firstmate.decision.open",
    commandId: CommandId.make(`open-${id}`),
    projectId,
    decisionId: FirstMateDecisionId.make(id),
    topicId: null,
    source,
    question: "What next?",
    options: [{ id: "answer-myself", label: "I'll answer", description: "Reply in the thread." }],
    recommendedOptionId: "answer-myself",
    blocking: true,
    createdAt,
  }) satisfies OrchestrationCommand;

const turnStart = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("command-turn-start"),
  threadId,
  message: {
    messageId: MessageId.make("message-reply"),
    role: "user" as const,
    text: "Go with option B",
    attachments: [],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: "2026-09-24T10:05:00.000Z",
};

const seed = Effect.gen(function* () {
  let readModel = createEmptyReadModel(createdAt);
  readModel = yield* apply(readModel, {
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    createdAt,
  });
  readModel = yield* apply(readModel, createThread(threadId));
  readModel = yield* apply(readModel, createThread(otherThreadId));
  readModel = yield* apply(
    readModel,
    openDecision("review-this-thread", {
      kind: "turn-review",
      threadId,
      turnId: TurnId.make("turn-1"),
    }),
  );
  readModel = yield* apply(
    readModel,
    openDecision("review-other-thread", {
      kind: "turn-review",
      threadId: otherThreadId,
      turnId: TurnId.make("turn-9"),
    }),
  );
  return yield* apply(
    readModel,
    openDecision("supervisor-question", { kind: "firstmate", sourceId: "question-1" }),
  );
});

const statusById = (readModel: OrchestrationReadModel) =>
  Object.fromEntries(
    (readModel.projects[0]?.firstMate?.decisions ?? []).map((decision) => [
      decision.id,
      decision.status,
    ]),
  );

it.layer(NodeServices.layer)("thread.turn.start with a pending turn-review card", (it) => {
  it.effect("cancels the card for this thread as soon as the user replies", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      expect(statusById(readModel)["review-this-thread"]).toBe("pending");

      const next = yield* apply(readModel, turnStart);

      expect(statusById(next)).toEqual({
        "review-this-thread": "cancelled",
        "review-other-thread": "pending",
        "supervisor-question": "pending",
      });
    }),
  );

  it.effect("emits nothing extra when no card is pending", () =>
    Effect.gen(function* () {
      const readModel = yield* apply(yield* seed, turnStart);
      const planned = yield* decideOrchestrationCommand({
        command: {
          ...turnStart,
          commandId: CommandId.make("command-turn-start-2"),
          message: { ...turnStart.message, messageId: MessageId.make("message-2") },
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );
});
