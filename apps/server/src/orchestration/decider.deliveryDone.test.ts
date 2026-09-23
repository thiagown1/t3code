import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadDeliveryStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-09-01T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

const readModelWithStatus = (deliveryStatus: ThreadDeliveryStatus | null) =>
  Effect.gen(function* () {
    const base = {
      causationEventId: null,
      metadata: {},
      occurredAt: createdAt,
    };
    const withProject = yield* projectEvent(createEmptyReadModel(createdAt), {
      ...base,
      sequence: 1,
      eventId: EventId.make("event-project-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      commandId: CommandId.make("command-project-created"),
      correlationId: CommandId.make("command-project-created"),
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
    const withThread = yield* projectEvent(withProject, {
      ...base,
      sequence: 2,
      eventId: EventId.make("event-thread-created"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      commandId: CommandId.make("command-thread-created"),
      correlationId: CommandId.make("command-thread-created"),
      payload: {
        threadId,
        projectId,
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
        updatedAt: createdAt,
      },
    });
    return yield* projectEvent(withThread, {
      ...base,
      sequence: 3,
      eventId: EventId.make("event-thread-meta"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.meta-updated",
      commandId: CommandId.make("command-thread-meta"),
      correlationId: CommandId.make("command-thread-meta"),
      payload: { threadId, deliveryStatus, updatedAt: createdAt },
    });
  });

const turnStart = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("command-turn-start"),
  threadId,
  message: {
    messageId: MessageId.make("message-1"),
    role: "user" as const,
    text: "One more thing",
    attachments: [],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt,
};

it.layer(NodeServices.layer)("thread.turn.start on a done thread", (it) => {
  it.effect("reopens the thread in the same event batch", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithStatus("done");
      const planned = yield* decideOrchestrationCommand({ command: turnStart, readModel });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "thread.meta-updated",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(events[0]?.payload).toMatchObject({ threadId, deliveryStatus: null });
    }),
  );

  it.effect("leaves other delivery statuses alone", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithStatus("waiting-deploy");
      const planned = yield* decideOrchestrationCommand({ command: turnStart, readModel });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );
});
