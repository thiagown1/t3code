import {
  CommandId,
  EventId,
  FirstMateTopicId,
  ProjectId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-09-14T20:00:00.000Z";
const projectId = ProjectId.make("project-firstmate");
const topicId = FirstMateTopicId.make("topic-monitoring");

const projectCreated: OrchestrationEvent = {
  sequence: 1,
  eventId: EventId.make("evt-firstmate-project"),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make("cmd-firstmate-project"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-firstmate-project"),
  metadata: {},
  payload: {
    projectId,
    title: "FirstMate",
    workspaceRoot: "/tmp/firstmate",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
};

it.layer(NodeServices.layer)("FirstMate orchestration decider", (it) => {
  it.effect("wraps accepted facts in the project event stream and rejects duplicates", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), projectCreated);
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "firstmate.topic.create",
          commandId: CommandId.make("cmd-firstmate-topic"),
          projectId,
          topicId,
          title: "Machine monitoring",
          summary: "Surface connected environment pressure.",
          stage: "implementation",
          threadId: null,
          responsibleAgentId: "firstmate",
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0]! : result;

      assert.equal(event.type, "firstmate.domain-event");
      assert.equal(event.aggregateKind, "project");
      assert.equal(event.aggregateId, projectId);
      assert.equal(event.payload.type, "firstmate.topic-created");

      const projected = yield* projectEvent(readModel, { ...event, sequence: 2 });
      assert.deepEqual(projected.projects[0]?.firstMate?.topics, [
        {
          id: topicId,
          projectId,
          title: "Machine monitoring",
          summary: "Surface connected environment pressure.",
          stage: "implementation",
          threadId: null,
          responsibleAgentId: "firstmate",
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
      ]);

      const duplicate = yield* decideOrchestrationCommand({
        command: {
          type: "firstmate.topic.create",
          commandId: CommandId.make("cmd-firstmate-topic-duplicate"),
          projectId,
          topicId,
          title: "Duplicate",
          summary: "Must be rejected.",
          stage: "planning",
          threadId: null,
          responsibleAgentId: null,
          createdAt: now,
        },
        readModel: projected,
      }).pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");
      if (duplicate._tag === "Failure") {
        assert.equal(duplicate.failure._tag, "OrchestrationCommandInvariantError");
        assert.include(duplicate.failure.message, "topic-already-exists");
      }
    }),
  );
});
