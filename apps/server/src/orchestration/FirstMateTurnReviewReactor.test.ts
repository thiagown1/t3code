import {
  EventId,
  FirstMateDecisionId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type FirstMateDecision,
  type FirstMateTurnReviewMode,
  type FirstMateWorkspaceState,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import {
  FIRST_MATE_CONTINUE_MESSAGE,
  type TurnReviewVerdict,
} from "@t3tools/shared/firstMateTurnReview";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  TurnReviewJudge,
  TurnReviewJudgeError,
  type TurnReviewJudgeInput,
} from "../firstMate/TurnReviewJudge.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { FirstMateTurnReviewReactor, layer } from "./FirstMateTurnReviewReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "./Services/RuntimeReceiptBus.ts";

const PROJECT_ID = ProjectId.make("project-1");
const WORKER_THREAD_ID = ThreadId.make("thread-worker");
const SUPERVISOR_THREAD_ID = ThreadId.make("thread-supervisor");
const TURN_ID = TurnId.make("turn-2");
const NOW = "2026-09-01T00:00:00.000Z";

function makeWorkspace(decisions: ReadonlyArray<FirstMateDecision> = []): FirstMateWorkspaceState {
  return {
    projectId: PROJECT_ID,
    supervisorThreadId: SUPERVISOR_THREAD_ID,
    selectedTopicId: null,
    topics: [],
    decisions,
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
    title: "Calculator",
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

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string,
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: TurnId.make(turnId),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const DEFAULT_MESSAGES = [
  message("m1", "user", "Build a calculator app.", "turn-1"),
  message("m2", "assistant", "Scaffolded the app.", "turn-1"),
  message("m3", "user", "Add tests too.", "turn-2"),
  message("m4", "assistant", "Added tests; all pass. Want me to deploy it?", "turn-2"),
];

function makeThreadDetail(
  shell: OrchestrationThreadShell,
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    messages: [...messages],
  } satisfies OrchestrationThread;
}

const turnCompleted = (): ProviderRuntimeEvent =>
  ({
    type: "turn.completed",
    eventId: EventId.make(`evt-${TURN_ID}`),
    provider: ProviderDriverKind.make("codex"),
    createdAt: NOW,
    threadId: WORKER_THREAD_ID,
    turnId: TURN_ID,
    payload: { state: "completed" },
  }) as ProviderRuntimeEvent;

interface HarnessOptions {
  readonly mode?: FirstMateTurnReviewMode;
  readonly verdict?: TurnReviewVerdict;
  readonly judgeUnavailable?: boolean;
  readonly shell?: Partial<OrchestrationThreadShell>;
  readonly decisions?: ReadonlyArray<FirstMateDecision>;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
}

const makeHarness = Effect.fn("makeFirstMateTurnReviewHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const judgeInputs = yield* Ref.make<ReadonlyArray<TurnReviewJudgeInput>>([]);
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const receipts = yield* Queue.unbounded<OrchestrationRuntimeReceipt>();
  const shell = makeThreadShell(options.shell ?? {});
  const project = makeProject(makeWorkspace(options.decisions ?? []));

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === shell.id ? Option.some(shell) : Option.none()),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getThreadDetailById: () =>
        Effect.succeed(Option.some(makeThreadDetail(shell, options.messages ?? DEFAULT_MESSAGES))),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
      streamDomainEvents: Stream.empty,
    }),
    Layer.mock(ProviderService)({
      streamEvents: Stream.fromQueue(runtimeEvents),
    }),
    Layer.succeed(TurnReviewJudge, {
      review: (input) =>
        Ref.update(judgeInputs, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.judgeUnavailable === true
              ? Effect.fail(
                  new TurnReviewJudgeError({
                    judge: "jev",
                    reason: "unavailable",
                    detail: "No OpenRouter API key is configured.",
                  }),
                )
              : Effect.succeed<TurnReviewVerdict>(
                  options.verdict ?? { outcome: "done", outcomeConfidence: 0.95, inScope: 1 },
                ),
          ),
        ),
    }),
    ServerSettings.layerTest({
      projectSettingsOverrides: {
        [PROJECT_ID]: { firstMateTurnReview: options.mode ?? "jev" },
      },
    }),
    Layer.succeed(RuntimeReceiptBus, {
      publish: (receipt) => Queue.offer(receipts, receipt).pipe(Effect.asVoid),
      streamEventsForTest: Stream.empty,
    }),
  );

  const context = yield* Layer.build(layer.pipe(Layer.provide(dependencies)));
  const reactor = yield* Effect.service(FirstMateTurnReviewReactor).pipe(Effect.provide(context));
  yield* reactor.start();

  return {
    commands,
    judgeInputs,
    emit: (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event),
    nextReceipt: Queue.take(receipts),
  };
});

describe("FirstMateTurnReviewReactor", () => {
  it.effect("marks a confidently finished thread done", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "firstmate.turn-review.settled",
        outcome: "marked-done",
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.meta.update", threadId: WORKER_THREAD_ID, deliveryStatus: "done" },
      ]);
      const [input] = yield* Ref.get(harness.judgeInputs);
      expect(input?.state).toMatchObject({
        title: "Calculator",
        originalRequest: "Build a calculator app.",
        latestRequest: "Add tests too.",
        lastAssistantMessageTail: "Added tests; all pass. Want me to deploy it?",
        turnState: "completed",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("queues the continue message for confident in-scope work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        verdict: { outcome: "continue", outcomeConfidence: 0.9, inScope: 0.9 },
      });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "continued" });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.queued-message.enqueue",
          threadId: WORKER_THREAD_ID,
          dispatchTiming: "after-current-turn",
          message: { text: FIRST_MATE_CONTINUE_MESSAGE },
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("asks the user instead of continuing past the loop cap", () =>
    Effect.gen(function* () {
      const autoContinues = Array.from({ length: 5 }, (_, index) => [
        message(`auto-${index}`, "user", FIRST_MATE_CONTINUE_MESSAGE, `turn-auto-${index}`),
        message(`reply-${index}`, "assistant", "Still going.", `turn-auto-${index}`),
      ]).flat();
      const harness = yield* makeHarness({
        verdict: { outcome: "continue", outcomeConfidence: 1, inScope: 1 },
        messages: [...DEFAULT_MESSAGES, ...autoContinues],
      });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "decision-opened" });
    }).pipe(Effect.scoped),
  );

  it.effect("opens a decision card when the agent needs the user", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        verdict: { outcome: "needs_user", outcomeConfidence: 0.9, inScope: 0.2 },
      });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "decision-opened" });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "firstmate.decision.open",
          projectId: PROJECT_ID,
          source: { kind: "turn-review", threadId: WORKER_THREAD_ID, turnId: TURN_ID },
          question: "Added tests; all pass. Want me to deploy it?",
          options: [{ id: "continue" }, { id: "mark-done" }, { id: "answer-myself" }],
          recommendedOptionId: "answer-myself",
          blocking: true,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels an older review card before reviewing the new turn", () =>
    Effect.gen(function* () {
      const staleId = FirstMateDecisionId.make("turn-review:thread-worker:turn-1");
      const harness = yield* makeHarness({
        decisions: [
          {
            id: staleId,
            projectId: PROJECT_ID,
            topicId: null,
            source: {
              kind: "turn-review",
              threadId: WORKER_THREAD_ID,
              turnId: TurnId.make("turn-1"),
            },
            question: "Scaffolded the app.",
            options: [{ id: "continue", label: "Continue", description: "Continue." }],
            recommendedOptionId: null,
            selectedOptionId: null,
            blocking: false,
            status: "pending",
            createdAt: NOW,
            updatedAt: NOW,
            resolvedAt: null,
          },
        ],
      });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "marked-done" });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "firstmate.decision.cancel", decisionId: staleId },
        { type: "thread.meta.update", deliveryStatus: "done" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a thread with a pending request to that request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shell: { hasPendingUserInput: true } });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "skipped" });
      expect(yield* Ref.get(harness.judgeInputs)).toHaveLength(0);
      expect(yield* Ref.get(harness.commands)).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("never calls a judge when turn review is off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mode: "off" });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "skipped" });
      expect(yield* Ref.get(harness.judgeInputs)).toHaveLength(0);
      expect(yield* Ref.get(harness.commands)).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("skips quietly when the judge is not configured", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ judgeUnavailable: true });
      yield* harness.emit(turnCompleted());
      expect(yield* harness.nextReceipt).toMatchObject({ outcome: "skipped" });
      expect(yield* Ref.get(harness.commands)).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
});
