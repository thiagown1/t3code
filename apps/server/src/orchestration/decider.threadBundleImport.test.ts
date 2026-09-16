import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FirstMateDecisionId,
  FirstMateTopicId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-09-15T18:00:00.000Z";
const projectId = ProjectId.make("target-project");

function projectReadModel(): Effect.Effect<OrchestrationReadModel, never> {
  return projectEvent(createEmptyReadModel(createdAt), {
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
  }).pipe(Effect.orDie);
}

function entry(targetThreadId: ThreadId, targetProjectId = projectId) {
  return {
    sourceEnvironmentId: "desk-a",
    sourceThreadId: ThreadId.make(`source-${targetThreadId}`),
    targetThreadId,
    projectId: targetProjectId,
    title: "Imported conversation",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    messages: [
      {
        messageId: MessageId.make(`message-${targetThreadId}`),
        role: "system" as const,
        text: "Portable context",
        attachments: [
          {
            type: "file" as const,
            id: `imported-${targetThreadId}-00000000-0000-4000-8000-000000000001-txt`,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
        ],
        createdAt,
        updatedAt: "2026-09-15T18:01:00.000Z",
      },
    ],
    proposedPlans: [
      {
        id: `plan-${targetThreadId}`,
        turnId: null,
        planMarkdown: "Implement safely",
        implementedAt: null,
        implementationThreadId: null,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    resolvedDecisions: [
      {
        topicId: FirstMateTopicId.make(`topic-${targetThreadId}`),
        decisionId: FirstMateDecisionId.make(`decision-${targetThreadId}`),
        sourceId: `bundle-${targetThreadId}`,
        question: "Proceed?",
        options: [{ id: "yes", label: "Yes", description: "Proceed safely" }],
        recommendedOptionId: "yes",
        selectedOptionId: "yes",
        blocking: true,
        resolvedAt: "2026-09-15T18:02:00.000Z",
      },
    ],
    createdAt,
    updatedAt: "2026-09-15T18:02:00.000Z",
  };
}

it.layer(NodeServices.layer)("thread bundle atomic import", (it) => {
  it.effect("projects messages, plans, and resolved decisions without a provider session", () =>
    Effect.gen(function* () {
      let readModel = yield* projectReadModel();
      const targetThreadId = ThreadId.make("imported-thread");
      const command = {
        type: "thread.bundle.import",
        commandId: CommandId.make("command-bundle-import"),
        threadId: targetThreadId,
        entries: [entry(targetThreadId)],
      } satisfies OrchestrationCommand;
      const decided = yield* decideOrchestrationCommand({ command, readModel });
      const events = Array.isArray(decided) ? decided : [decided];
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        readModel = yield* projectEvent(readModel, { ...event, sequence: ++sequence });
      }

      const thread = readModel.threads.find((candidate) => candidate.id === targetThreadId);
      const project = readModel.projects.find((candidate) => candidate.id === projectId);
      expect(thread).toMatchObject({
        session: null,
        messages: [
          {
            role: "system",
            text: "Portable context",
            attachments: [
              {
                type: "file",
                name: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: 5,
              },
            ],
            updatedAt: "2026-09-15T18:01:00.000Z",
          },
        ],
        proposedPlans: [{ planMarkdown: "Implement safely" }],
      });
      expect(project?.firstMate?.topics).toMatchObject([
        { threadId: targetThreadId, stage: "completed" },
      ]);
      expect(project?.firstMate?.decisions).toMatchObject([
        { status: "resolved", selectedOptionId: "yes" },
      ]);
    }),
  );

  it.effect("rejects the complete command when a later entry has no project", () =>
    Effect.gen(function* () {
      const readModel = yield* projectReadModel();
      const firstThreadId = ThreadId.make("first-thread");
      const secondThreadId = ThreadId.make("second-thread");
      const command = {
        type: "thread.bundle.import",
        commandId: CommandId.make("command-bundle-blocked"),
        threadId: secondThreadId,
        entries: [entry(firstThreadId), entry(secondThreadId, ProjectId.make("missing-project"))],
      } satisfies OrchestrationCommand;

      const result = yield* Effect.exit(decideOrchestrationCommand({ command, readModel }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(readModel.threads).toHaveLength(0);
    }),
  );
});
