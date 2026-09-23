import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { make } from "./ThreadQueuedMessageReactor.ts";

const threadId = ThreadId.make("thread-queue");
const createdAt = "2026-09-18T10:00:00.000Z";

let randomByte = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill((randomByte = (randomByte + 1) % 251)),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function shell(sessionStatus: string): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Queue thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId,
      status: sessionStatus,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: createdAt,
    },
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as unknown as OrchestrationThreadShell;
}

function threadEvent(input: {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make(`event-${input.id}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: input.type,
    occurredAt: createdAt,
    commandId: CommandId.make(`command-${input.id}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-${input.id}`),
    metadata: {},
    payload: input.payload,
  } as unknown as OrchestrationEvent;
}

function activityEvent(activity: OrchestrationThreadActivity): OrchestrationEvent {
  return threadEvent({
    id: activity.id,
    type: "thread.activity-appended",
    payload: { threadId, activity },
  });
}

function enqueuedEvent(suffix: string): OrchestrationEvent {
  return activityEvent({
    id: EventId.make(`activity-enqueue-${suffix}`),
    tone: "info",
    kind: THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.enqueued,
    summary: "Message queued",
    payload: {
      threadId,
      queuedMessageId: `queued-${suffix}`,
      message: {
        messageId: MessageId.make(`message-${suffix}`),
        role: "user",
        text: `follow up ${suffix}`,
        attachments: [],
      },
      dispatchTiming: "next-boundary",
      queuedAfterActivityId: null,
      createdAt,
    },
    turnId: null,
    createdAt,
  });
}

/** The projector echo of a receipt the reactor appended, as the live stream would carry it. */
function closedEvent(suffix: string, reason: string): OrchestrationEvent {
  return activityEvent({
    id: EventId.make(`activity-closed-${suffix}-${reason}`),
    tone: "info",
    kind: THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.closed,
    summary: "Queued message left the queue",
    payload: { queuedMessageId: `queued-${suffix}`, reason },
    turnId: null,
    createdAt,
  });
}

function releasedEvent(suffix: string): OrchestrationEvent {
  return activityEvent({
    id: EventId.make(`activity-released-${suffix}`),
    tone: "info",
    kind: THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.released,
    summary: "Queued message released",
    payload: { queuedMessageId: `queued-${suffix}` },
    turnId: null,
    createdAt,
  });
}

function toolCompletedEvent(suffix: string): OrchestrationEvent {
  return activityEvent({
    id: EventId.make(`activity-tool-${suffix}`),
    tone: "tool",
    kind: "tool.completed",
    summary: "Read a file",
    payload: {},
    turnId: null,
    createdAt,
  });
}

function sessionSetEvent(status: string): OrchestrationEvent {
  return threadEvent({
    id: `session-${status}`,
    type: "thread.session-set",
    payload: { threadId, session: shell(status).session },
  });
}

const makeHarness = (initialStatus: string) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const commands = yield* Queue.unbounded<OrchestrationCommand>();
    let sessionStatus = initialStatus;
    let failTurnStart = false;

    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        command.type === "thread.turn.start" && failTurnStart
          ? Effect.die("provider refused the turn")
          : Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 })),
      streamDomainEvents: Stream.fromPubSub(events),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    } as unknown as OrchestrationEngineShape;

    const reactor = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () => Effect.succeed(Option.some(shell(sessionStatus))),
            listActivitiesByKind: () => Effect.succeed([]),
          }),
          Layer.succeed(Crypto.Crypto, testCrypto),
        ),
      ),
    );
    yield* reactor.start();

    return {
      publish: (event: OrchestrationEvent) => PubSub.publish(events, event).pipe(Effect.asVoid),
      /** Blocks until the reactor dispatches. The only synchronisation the tests need. */
      nextCommand: Queue.take(commands),
      drain: reactor.drain,
      pendingCommands: Queue.size(commands),
      setTurnStartFailure: (fail: boolean) => {
        failTurnStart = fail;
      },
    };
  });

describe("ThreadQueuedMessageReactor", () => {
  it.effect("releases one queued message per tool boundary, in order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("running");
        yield* harness.publish(enqueuedEvent("a"));
        yield* harness.publish(enqueuedEvent("b"));
        yield* harness.publish(toolCompletedEvent("1"));

        const firstTurn = yield* harness.nextCommand;
        expect(firstTurn).toMatchObject({
          type: "thread.turn.start",
          threadId,
          message: { text: "follow up a" },
        });
        expect(yield* harness.nextCommand).toMatchObject({
          type: "thread.activity.append",
          activity: {
            kind: THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.closed,
            payload: { queuedMessageId: "queued-a", reason: "dispatched" },
          },
        });

        // The projector echoes the receipt and the provider reports the session.
        // The second entry lost its boundary with the first dispatch, so it waits
        // for a new one rather than following straight out.
        yield* harness.publish(closedEvent("a", "dispatched"));
        yield* harness.publish(sessionSetEvent("running"));
        yield* harness.publish(toolCompletedEvent("2"));

        expect(yield* harness.nextCommand).toMatchObject({
          type: "thread.turn.start",
          message: { text: "follow up b" },
        });

        // Everything the reactor saw has been evaluated and nothing else went out.
        yield* harness.drain;
        expect(yield* harness.pendingCommands).toBe(1);
      }),
    ),
  );

  it.effect("starts a queued turn with no client attached to the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Session already settled: the message is due the moment it is queued.
        const harness = yield* makeHarness("ready");
        yield* harness.publish(enqueuedEvent("a"));

        expect(yield* harness.nextCommand).toMatchObject({
          type: "thread.turn.start",
          message: { text: "follow up a" },
        });
      }),
    ),
  );

  it.effect("holds the head after a failed dispatch and does not retry on the next boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("ready");
        harness.setTurnStartFailure(true);
        yield* harness.publish(enqueuedEvent("a"));

        expect(yield* harness.nextCommand).toMatchObject({
          type: "thread.activity.append",
          activity: {
            kind: THREAD_QUEUED_MESSAGE_ACTIVITY_KINDS.held,
            payload: { queuedMessageId: "queued-a" },
          },
        });

        // A boundary must not retry a held entry; only Send now may.
        yield* harness.publish(toolCompletedEvent("1"));
        harness.setTurnStartFailure(false);
        yield* harness.publish(releasedEvent("a"));

        // A retry on the boundary would have produced a second hold before this.
        expect(yield* harness.nextCommand).toMatchObject({
          type: "thread.turn.start",
          message: { text: "follow up a" },
        });
      }),
    ),
  );

  it.effect("drops the whole queue when the user interrupts the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("running");
        yield* harness.publish(enqueuedEvent("a"));
        yield* harness.publish(enqueuedEvent("b"));
        yield* harness.publish(
          threadEvent({
            id: "interrupt",
            type: "thread.turn-interrupt-requested",
            payload: { threadId, createdAt },
          }),
        );

        expect([yield* harness.nextCommand, yield* harness.nextCommand]).toMatchObject([
          { activity: { payload: { queuedMessageId: "queued-a", reason: "interrupted" } } },
          { activity: { payload: { queuedMessageId: "queued-b", reason: "interrupted" } } },
        ]);

        // The projector echoes both receipts, then a fresh message is queued and
        // a tool call finishes. Only the new message may go: if the interrupted
        // ones were still queued they would be ahead of it.
        yield* harness.publish(closedEvent("a", "interrupted"));
        yield* harness.publish(closedEvent("b", "interrupted"));
        yield* harness.publish(enqueuedEvent("c"));
        yield* harness.publish(toolCompletedEvent("1"));

        expect(yield* harness.nextCommand).toMatchObject({
          type: "thread.turn.start",
          message: { text: "follow up c" },
        });
      }),
    ),
  );
});
