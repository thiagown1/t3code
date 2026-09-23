import {
  EventId,
  FirstMateTopicId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type FirstMateTopic,
  type FirstMateWorkspaceState,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  TextGenerationError,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { FirstMateRoundSummaryReactor, layer } from "./FirstMateRoundSummaryReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "./Services/RuntimeReceiptBus.ts";

const PROJECT_ID = ProjectId.make("project-1");
const WORKER_THREAD_ID = ThreadId.make("thread-worker");
const SUPERVISOR_THREAD_ID = ThreadId.make("thread-supervisor");
const TOPIC_ID = FirstMateTopicId.make("topic-1");
const TURN_ID = TurnId.make("turn-1");
const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_MODEL = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "haiku",
};

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeTopic(overrides: Partial<FirstMateTopic> = {}): FirstMateTopic {
  return {
    id: TOPIC_ID,
    projectId: PROJECT_ID,
    title: "Rate limits",
    summary: "Decide how auth rate limits behave.",
    stage: "implementation",
    threadId: WORKER_THREAD_ID,
    responsibleAgentId: "codex",
    latestRoundSummary: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function makeWorkspace(topics: ReadonlyArray<FirstMateTopic>): FirstMateWorkspaceState {
  return {
    projectId: PROJECT_ID,
    supervisorThreadId: SUPERVISOR_THREAD_ID,
    selectedTopicId: null,
    topics,
    decisions: [],
    routingReceipts: [],
    routingEvaluationMode: "off",
    updatedAt: NOW,
  };
}

function makeProject(firstMate: FirstMateWorkspaceState | null): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    firstMate,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThreadShell(overrides: Partial<OrchestrationThreadShell> = {}) {
  return {
    id: WORKER_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Worker",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/workspace/worktree",
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: WORKER_THREAD_ID,
      status: "idle",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } satisfies OrchestrationThreadShell;
}

function makeThreadDetail(shell: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    messages: [
      {
        id: MessageId.make("message-old"),
        role: "assistant",
        text: "Work from an earlier round.",
        turnId: TurnId.make("turn-0"),
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: MessageId.make("message-user"),
        role: "user",
        text: "Add the rate limit middleware.",
        turnId: TURN_ID,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: MessageId.make("message-assistant"),
        role: "assistant",
        text: "Added the middleware; the integration test still fails on Windows.",
        turnId: TURN_ID,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  } satisfies OrchestrationThread;
}

const turnCompleted = (
  overrides: {
    readonly threadId?: ThreadId;
    readonly turnId?: TurnId;
    readonly state?: "completed" | "failed" | "interrupted";
  } = {},
): ProviderRuntimeEvent =>
  ({
    type: "turn.completed",
    eventId: EventId.make(`evt-${overrides.turnId ?? TURN_ID}-${overrides.state ?? "completed"}`),
    provider: ProviderDriverKind.make("codex"),
    createdAt: NOW,
    threadId: overrides.threadId ?? WORKER_THREAD_ID,
    turnId: overrides.turnId ?? TURN_ID,
    payload: { state: overrides.state ?? "completed" },
  }) as ProviderRuntimeEvent;

interface HarnessOptions {
  readonly workspace?: FirstMateWorkspaceState | null;
  readonly shell?: Partial<OrchestrationThreadShell>;
  readonly summary?: string;
  readonly failGeneration?: boolean;
}

const makeHarness = Effect.fn("makeFirstMateRoundSummaryHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const summaryInputs = yield* Ref.make<ReadonlyArray<TextGeneration.RoundSummaryGenerationInput>>(
    [],
  );
  // Queue-backed rather than PubSub-backed on both sides: an event offered
  // before the reactor subscribes is still delivered, and a receipt published
  // before the test reads it is still there. Nothing here waits on a clock.
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const receipts = yield* Queue.unbounded<OrchestrationRuntimeReceipt>();
  const shell = makeThreadShell(options.shell ?? {});
  const project = makeProject(
    options.workspace === undefined ? makeWorkspace([makeTopic()]) : options.workspace,
  );

  const textGeneration = TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateTurnReview: () => Effect.die("unused"),
    generateRoundSummary: (input) =>
      Ref.update(summaryInputs, (recorded) => [...recorded, input]).pipe(
        Effect.andThen(
          options.failGeneration === true
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateRoundSummary",
                  detail: "summary model unavailable",
                }),
              )
            : Effect.succeed({
                summary: options.summary ?? "Added the middleware; the Windows test still fails.",
              }),
        ),
      ),
  });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === shell.id ? Option.some(shell) : Option.none()),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getThreadDetailSnapshot: () =>
        Effect.succeed(Option.some({ snapshotSequence: 1, thread: makeThreadDetail(shell) })),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
      streamDomainEvents: Stream.empty,
    }),
    Layer.mock(ProviderService)({
      streamEvents: Stream.fromQueue(runtimeEvents),
    }),
    Layer.succeed(TextGeneration.TextGeneration, textGeneration),
    ServerSettings.layerTest({
      projectSettingsOverrides: {
        [PROJECT_ID]: { textGenerationModelSelection: PROJECT_MODEL },
      },
    }),
    Layer.succeed(RuntimeReceiptBus, {
      publish: (receipt) => Queue.offer(receipts, receipt).pipe(Effect.asVoid),
      streamEventsForTest: Stream.empty,
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  // Built into the test's scope: the reactor's worker fiber has to outlive the
  // call that acquires the service.
  const context = yield* Layer.build(layer.pipe(Layer.provide(dependencies)));
  const reactor = yield* Effect.service(FirstMateRoundSummaryReactor).pipe(Effect.provide(context));
  yield* reactor.start();

  return {
    reactor,
    commands,
    summaryInputs,
    emit: (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event),
    /** Resolves once the reactor has finished deciding about a round. */
    nextReceipt: Queue.take(receipts),
  };
});

describe("FirstMateRoundSummaryReactor", () => {
  it.effect("summarizes a delegated round on the project's text generation model", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "firstmate.round-summary.settled",
        outcome: "recorded",
        topicId: TOPIC_ID,
        turnId: TURN_ID,
      });

      const [input] = yield* Ref.get(harness.summaryInputs);
      expect(input?.modelSelection).toMatchObject(PROJECT_MODEL);
      expect(input?.topicTitle).toBe("Rate limits");
      expect(input?.cwd).toBe("/workspace/worktree");
      // Only the finished round reaches the model, never the whole thread.
      expect(input?.transcript).toContain("Add the rate limit middleware.");
      expect(input?.transcript).not.toContain("Work from an earlier round.");

      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "firstmate.topic.record-round-summary",
          topicId: TOPIC_ID,
          threadId: WORKER_THREAD_ID,
          turnId: TURN_ID,
          text: "Added the middleware; the Windows test still fails.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves undelegated threads alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        workspace: makeWorkspace([makeTopic({ threadId: null })]),
      });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "skipped", topicId: null });
      expect(yield* Ref.get(harness.summaryInputs)).toHaveLength(0);
      expect(yield* Ref.get(harness.commands)).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("waits instead of summarizing a round with live work behind it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shell: { backgroundLiveness: "working" } });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "skipped" });
      expect(yield* Ref.get(harness.summaryInputs)).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not pay the model twice for the same round", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        workspace: makeWorkspace([
          makeTopic({
            latestRoundSummary: {
              threadId: WORKER_THREAD_ID,
              turnId: TURN_ID,
              text: "Already summarized.",
              generatedAt: NOW,
            },
          }),
        ]),
      });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "skipped", topicId: TOPIC_ID });
      expect(yield* Ref.get(harness.summaryInputs)).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores an interrupted round", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.emit(turnCompleted({ state: "interrupted" }));
      yield* harness.emit(turnCompleted());
      // The interrupted turn never reaches the worker, so the first receipt is
      // the completed one.
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "recorded" });
      expect(yield* Ref.get(harness.summaryInputs)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed summary without failing the turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failGeneration: true });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "failed" });
      expect(yield* Ref.get(harness.commands)).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
});
