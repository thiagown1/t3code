import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadQueuedMessageId,
  foldThreadQueuedMessages,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-09-18T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-queue");

const readModelWithThread = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(createdAt), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-created"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Queue thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
});

let commandClock = 0;
/** Distinct timestamps: activities without a producer sequence sort by time. */
function nextCreatedAt() {
  commandClock += 1;
  return `2026-09-18T10:00:${String(commandClock).padStart(2, "0")}.000Z`;
}

function enqueueCommand(suffix: string) {
  return {
    type: "thread.queued-message.enqueue" as const,
    commandId: CommandId.make(`command-enqueue-${suffix}`),
    threadId,
    queuedMessageId: ThreadQueuedMessageId.make(`queued-${suffix}`),
    message: {
      messageId: MessageId.make(`message-${suffix}`),
      role: "user" as const,
      text: `follow up ${suffix}`,
      attachments: [],
    },
    dispatchTiming: "next-boundary" as const,
    queuedAfterActivityId: null,
    createdAt: nextCreatedAt(),
  };
}

function updateCommand(suffix: string, action: "cancel" | "release") {
  return {
    type: "thread.queued-message.update" as const,
    commandId: CommandId.make(`command-${action}-${suffix}`),
    threadId,
    queuedMessageId: ThreadQueuedMessageId.make(`queued-${suffix}`),
    action,
    createdAt: nextCreatedAt(),
  };
}

const applyCommand = Effect.fn("applyCommand")(function* (input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: Parameters<typeof decideOrchestrationCommand>[0]["command"];
  readonly sequence: number;
}) {
  const planned = yield* decideOrchestrationCommand({
    command: input.command,
    readModel: input.readModel,
  });
  const events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> = Array.isArray(planned)
    ? planned
    : [planned];
  let readModel = input.readModel;
  let sequence = input.sequence;
  for (const event of events) {
    readModel = yield* projectEvent(readModel, { ...event, sequence } as OrchestrationEvent);
    sequence += 1;
  }
  return { readModel, events, nextSequence: sequence };
});

function queueOf(readModel: OrchestrationReadModel) {
  return foldThreadQueuedMessages(
    readModel.threads.find((thread) => thread.id === threadId)?.activities ?? [],
  );
}

it.layer(NodeServices.layer)("queued message commands", (it) => {
  it.effect("records an enqueue as one pending queue entry", () =>
    Effect.gen(function* () {
      const base = yield* readModelWithThread;
      const first = yield* applyCommand({
        readModel: base,
        command: enqueueCommand("a"),
        sequence: 3,
      });
      expect(first.events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      const second = yield* applyCommand({
        readModel: first.readModel,
        command: enqueueCommand("b"),
        sequence: first.nextSequence,
      });

      expect(queueOf(second.readModel).map((entry) => entry.enqueued.message.text)).toEqual([
        "follow up a",
        "follow up b",
      ]);
    }),
  );

  it.effect("refuses to queue the same message twice", () =>
    Effect.gen(function* () {
      const base = yield* readModelWithThread;
      const first = yield* applyCommand({
        readModel: base,
        command: enqueueCommand("a"),
        sequence: 3,
      });
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: enqueueCommand("a"),
          readModel: first.readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("already queued");
    }),
  );

  it.effect("cancel removes the entry and leaves the rest in order", () =>
    Effect.gen(function* () {
      const base = yield* readModelWithThread;
      const first = yield* applyCommand({
        readModel: base,
        command: enqueueCommand("a"),
        sequence: 3,
      });
      const second = yield* applyCommand({
        readModel: first.readModel,
        command: enqueueCommand("b"),
        sequence: first.nextSequence,
      });
      const canceled = yield* applyCommand({
        readModel: second.readModel,
        command: updateCommand("a", "cancel"),
        sequence: second.nextSequence,
      });

      expect(queueOf(canceled.readModel).map((entry) => entry.queuedMessageId)).toEqual([
        "queued-b",
      ]);
    }),
  );

  it.effect("release marks the entry due without changing its place", () =>
    Effect.gen(function* () {
      const base = yield* readModelWithThread;
      const first = yield* applyCommand({
        readModel: base,
        command: enqueueCommand("a"),
        sequence: 3,
      });
      const released = yield* applyCommand({
        readModel: first.readModel,
        command: updateCommand("a", "release"),
        sequence: first.nextSequence,
      });

      expect(queueOf(released.readModel)).toMatchObject([
        { queuedMessageId: "queued-a", released: true, held: false },
      ]);
    }),
  );

  it.effect("a cancel that raced the dispatch is a no-op, not a failure", () =>
    Effect.gen(function* () {
      const base = yield* readModelWithThread;
      const canceled = yield* applyCommand({
        readModel: base,
        command: updateCommand("gone", "cancel"),
        sequence: 3,
      });
      expect(queueOf(canceled.readModel)).toEqual([]);
    }),
  );

  it.effect("rejects an enqueue for a thread that does not exist", () =>
    Effect.gen(function* () {
      const base = yield* readModelWithThread;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: { ...enqueueCommand("a"), threadId: ThreadId.make("missing") },
          readModel: base,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
