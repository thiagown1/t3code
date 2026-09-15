import {
  CommandId,
  CorrelationId,
  EventId,
  ProviderDriverKind,
  ThreadId,
  type InternalOrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { processThreadArchived } from "./ThreadArchiveReactor.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-archive-reactor");
const archivedEvent: Extract<OrchestrationEvent, { type: "thread.archived" }> = {
  sequence: 1,
  eventId: EventId.make("evt-thread-archived"),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.archived",
  occurredAt: now,
  commandId: CommandId.make("cmd-thread-archived"),
  causationEventId: null,
  correlationId: CorrelationId.make("cmd-thread-archived"),
  metadata: {},
  payload: { threadId, archivedAt: now, updatedAt: now },
};

function runArchive(input: {
  readonly archiveConversation: ProviderServiceShape["archiveConversation"];
  readonly stopSession?: ProviderServiceShape["stopSession"];
  readonly close?: TerminalManager.TerminalManager["Service"]["close"];
}) {
  return Effect.gen(function* () {
    let dispatched: InternalOrchestrationCommand | undefined;
    const stops: ThreadId[] = [];
    const closes: ThreadId[] = [];
    const providerService = {
      archiveConversation: input.archiveConversation,
      stopSession:
        input.stopSession ??
        ((request) =>
          Effect.sync(() => {
            stops.push(request.threadId);
          })),
    } as unknown as ProviderServiceShape;
    const terminalManager = {
      close:
        input.close ??
        ((request: { readonly threadId: ThreadId }) =>
          Effect.sync(() => {
            closes.push(request.threadId);
          })),
    } as unknown as TerminalManager.TerminalManager["Service"];
    const engine = {
      dispatch: (command: InternalOrchestrationCommand) =>
        Effect.sync(() => {
          dispatched = command;
          return { ...archivedEvent, sequence: 2, type: "thread.activity-appended" } as never;
        }),
    } as unknown as OrchestrationEngineShape;

    yield* processThreadArchived({
      event: archivedEvent,
      providerService,
      terminalManager,
      orchestrationEngine: engine,
    });
    return { command: dispatched!, stops, closes };
  });
}

describe("ThreadArchiveReactor", () => {
  effectIt.effect("records native provider archive and preserves the local transcript", () =>
    Effect.gen(function* () {
      const result = yield* runArchive({
        archiveConversation: () =>
          Effect.succeed({ provider: ProviderDriverKind.make("codex"), status: "archived" }),
      });

      expect(result.stops).toEqual([threadId]);
      expect(result.closes).toEqual([threadId]);
      expect(result.command.type).toBe("thread.activity.append");
      if (result.command.type !== "thread.activity.append") return;
      expect(result.command.activity.tone).toBe("info");
      expect(result.command.activity.payload).toEqual({
        local: { status: "archived", transcript: "preserved" },
        provider: { provider: ProviderDriverKind.make("codex"), status: "archived" },
        runtime: { status: "succeeded" },
        terminals: { status: "succeeded", history: "preserved" },
      });
    }),
  );

  effectIt.effect("records unsupported providers without emulating remote archive", () =>
    Effect.gen(function* () {
      const result = yield* runArchive({
        archiveConversation: () =>
          Effect.succeed({
            provider: ProviderDriverKind.make("claudeAgent"),
            status: "unsupported",
          }),
      });

      expect(result.command.type).toBe("thread.activity.append");
      if (result.command.type !== "thread.activity.append") return;
      expect(result.command.activity.tone).toBe("info");
      expect(result.command.activity.summary).toContain("does not support remote archiving");
    }),
  );

  effectIt.effect("records an imported thread as not linked without stopping a provider", () =>
    Effect.gen(function* () {
      const result = yield* runArchive({
        archiveConversation: () => Effect.succeed({ status: "not-linked" }),
      });

      expect(result.stops).toEqual([]);
      expect(result.closes).toEqual([threadId]);
      expect(result.command.type).toBe("thread.activity.append");
      if (result.command.type !== "thread.activity.append") return;
      expect(result.command.activity.tone).toBe("info");
      expect(result.command.activity.payload).toMatchObject({
        provider: { status: "not-linked" },
        runtime: { status: "not-running" },
        terminals: { status: "succeeded", history: "preserved" },
      });
    }),
  );

  effectIt.effect("still stops resources and records a failed provider archive", () =>
    Effect.gen(function* () {
      const result = yield* runArchive({
        archiveConversation: () => Effect.fail({ _tag: "ArchiveFailed" } as never),
      });

      expect(result.stops).toEqual([threadId]);
      expect(result.closes).toEqual([threadId]);
      expect(result.command.type).toBe("thread.activity.append");
      if (result.command.type !== "thread.activity.append") return;
      expect(result.command.activity.tone).toBe("error");
      expect(result.command.activity.payload).toMatchObject({
        provider: { status: "failed" },
        runtime: { status: "succeeded" },
        terminals: { status: "succeeded", history: "preserved" },
      });
    }),
  );
});
