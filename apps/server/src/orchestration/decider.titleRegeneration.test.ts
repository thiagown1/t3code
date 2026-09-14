import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Manual title",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: UPDATED_AT,
};

it.layer(NodeServices.layer)("title regeneration decider", (it) => {
  it.effect("preserves updatedAt for a stale completion", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("cmd-regeneration-complete"),
          threadId: ThreadId.make("thread-1"),
          requestId: CommandId.make("cmd-old-regeneration-request"),
          title: "Generated title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload).toEqual({
          threadId: ThreadId.make("thread-1"),
          updatedAt: UPDATED_AT,
        });
      }
    }),
  );

  it.effect("persists and clears an operator delivery gate through metadata", () =>
    Effect.gen(function* () {
      const waiting = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-waiting-deploy"),
          threadId: ThreadId.make("thread-1"),
          deliveryStatus: "waiting-deploy",
        },
        readModel,
      });
      const waitingEvent = Array.isArray(waiting) ? waiting[0] : waiting;
      expect(waitingEvent).toMatchObject({
        type: "thread.meta-updated",
        payload: { threadId: ThreadId.make("thread-1"), deliveryStatus: "waiting-deploy" },
      });

      const cleared = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-clear-delivery-status"),
          threadId: ThreadId.make("thread-1"),
          deliveryStatus: null,
        },
        readModel,
      });
      const clearedEvent = Array.isArray(cleared) ? cleared[0] : cleared;
      expect(clearedEvent).toMatchObject({
        type: "thread.meta-updated",
        payload: { threadId: ThreadId.make("thread-1"), deliveryStatus: null },
      });
    }),
  );
});
