import {
  CommandId,
  EventId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
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
          latestRoundSummary: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
      ]);

      const selectedResult = yield* decideOrchestrationCommand({
        command: {
          type: "firstmate.topic.select",
          commandId: CommandId.make("cmd-firstmate-select-topic"),
          projectId,
          topicId,
          createdAt: now,
        },
        readModel: projected,
      });
      const selectedEvent = Array.isArray(selectedResult) ? selectedResult[0]! : selectedResult;
      const selected = yield* projectEvent(projected, { ...selectedEvent, sequence: 3 });
      assert.equal(selected.projects[0]?.firstMate?.selectedTopicId, topicId);

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

  it.effect("creates one FirstMate chat and recreates it once archived", () =>
    Effect.gen(function* () {
      let readModel = yield* projectEvent(createEmptyReadModel(now), projectCreated);
      const ensure = (threadId: ThreadId) =>
        decideOrchestrationCommand({
          command: {
            type: "firstmate.supervisor.ensure",
            commandId: CommandId.make(`cmd-ensure-${threadId}`),
            projectId,
            threadId,
            modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
            runtimeMode: "full-access",
            createdAt: now,
          },
          readModel,
        });
      const first = yield* ensure(ThreadId.make("firstmate-1"));
      const firstEvents = Array.isArray(first) ? first : [first];
      assert.deepEqual(
        firstEvents.map((event) => event.type),
        ["thread.created", "firstmate.domain-event"],
      );
      for (const event of firstEvents) {
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
      }
      assert.equal(readModel.projects[0]?.firstMate?.supervisorThreadId, "firstmate-1");
      assert.equal(readModel.threads[0]?.title, "FirstMate");
      assert.equal(readModel.threads[0]?.modelSelection.model, "opus");

      const duplicate = yield* ensure(ThreadId.make("firstmate-2")).pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");

      const archived = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-firstmate"),
          threadId: ThreadId.make("firstmate-1"),
        },
        readModel,
      });
      for (const event of Array.isArray(archived) ? archived : [archived]) {
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
      }
      const recreated = yield* ensure(ThreadId.make("firstmate-2"));
      const recreatedEvents = Array.isArray(recreated) ? recreated : [recreated];
      assert.equal(recreatedEvents[0]?.type, "thread.created");
    }),
  );
});
