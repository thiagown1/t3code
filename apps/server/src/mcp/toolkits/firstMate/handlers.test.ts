import {
  EnvironmentId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FirstMateDecision,
  type FirstMateTopic,
  type FirstMateWorkspaceState,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FirstMateToolkitHandlersLive } from "./handlers.ts";
import { FIRST_MATE_TOPIC_LIST_LIMIT, FirstMateToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const SUPERVISOR_THREAD_ID = ThreadId.make("thread-supervisor");
const WORKER_THREAD_ID = ThreadId.make("thread-worker");
const TOPIC_ID = FirstMateTopicId.make("topic-1");
const NOW = "2026-08-01T00:00:00.000Z";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set<McpInvocationContext.McpCapability>(["pull-requests"]),
  issuedAt: 1,
});

function makeTopic(overrides: Partial<FirstMateTopic> = {}): FirstMateTopic {
  return {
    id: TOPIC_ID,
    projectId: PROJECT_ID,
    title: "Rate limits",
    summary: "Decide how auth rate limits behave.",
    stage: "research",
    threadId: null,
    responsibleAgentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function makePendingDecision(
  id: string,
  topicId: FirstMateTopic["id"],
  blocking = false,
): FirstMateDecision {
  return {
    id: FirstMateDecisionId.make(id),
    projectId: PROJECT_ID,
    topicId,
    source: { kind: "firstmate", sourceId: SUPERVISOR_THREAD_ID },
    question: `Question ${id}`,
    options: [
      { id: "a", label: "A", description: "First." },
      { id: "b", label: "B", description: "Second." },
    ],
    recommendedOptionId: "a",
    selectedOptionId: null,
    blocking,
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
  };
}

function makeWorkspace(overrides: Partial<FirstMateWorkspaceState> = {}): FirstMateWorkspaceState {
  return {
    projectId: PROJECT_ID,
    supervisorThreadId: SUPERVISOR_THREAD_ID,
    selectedTopicId: null,
    topics: [makeTopic()],
    decisions: [],
    routingReceipts: [],
    routingEvaluationMode: "off",
    updatedAt: NOW,
    ...overrides,
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

function makeThread(id: ThreadId): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

interface HarnessOptions {
  readonly firstMate?: FirstMateWorkspaceState | null;
  readonly reject?: (command: OrchestrationCommand) => OrchestrationCommandInvariantError | null;
}

const makeHarness = Effect.fn("makeFirstMateToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const project = makeProject(
    options.firstMate === undefined ? makeWorkspace() : options.firstMate,
  );
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) return yield* rejection;
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(
          threadId === SUPERVISOR_THREAD_ID || threadId === WORKER_THREAD_ID
            ? Option.some(makeThread(threadId))
            : Option.none(),
        ),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* FirstMateToolkit.pipe(
    Effect.provide(FirstMateToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof FirstMateToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    threadId: ThreadId = SUPERVISOR_THREAD_ID,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof FirstMateToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(threadId)),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("FirstMate toolkit handlers", () => {
  it.effect("creates a topic and reports the id it minted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("firstmate_create_topic", {
        title: "Auth rate limits",
        summary: "Pick a limiter for the auth endpoints.",
      });
      expect(result).toMatchObject({
        title: "Auth rate limits",
        stage: "research",
        threadId: null,
        responsibleAgentId: null,
      });
      expect(result.topicId.startsWith("topic-")).toBe(true);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "firstmate.topic.create",
          projectId: PROJECT_ID,
          topicId: result.topicId,
          stage: "research",
          threadId: null,
        },
      ]);
    }),
  );

  it.effect("refuses every tool outside the supervisor thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call(
          "firstmate_create_topic",
          { title: "Anything", summary: "From a worker thread." },
          WORKER_THREAD_ID,
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "FirstMateSupervisorOnlyError",
        threadId: WORKER_THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("refuses when the project has no linked supervisor at all", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        firstMate: makeWorkspace({ supervisorThreadId: null }),
      });
      const error = yield* harness
        .call("firstmate_create_topic", { title: "Anything", summary: "No supervisor yet." })
        .pipe(Effect.flip);
      expect(error._tag).toBe("FirstMateSupervisorOnlyError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("delegates a topic to a worker thread and keeps the agent assignment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        firstMate: makeWorkspace({ topics: [makeTopic({ responsibleAgentId: "codex" })] }),
      });
      const result = yield* harness.call("firstmate_delegate_topic", {
        topicId: TOPIC_ID,
        threadId: WORKER_THREAD_ID,
      });
      expect(result).toMatchObject({
        topicId: TOPIC_ID,
        threadId: WORKER_THREAD_ID,
        responsibleAgentId: "codex",
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "firstmate.topic.delegate",
          topicId: TOPIC_ID,
          threadId: WORKER_THREAD_ID,
          responsibleAgentId: "codex",
        },
      ]);
    }),
  );

  it.effect("refuses to delegate a topic back to the supervisor thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("firstmate_delegate_topic", {
          topicId: TOPIC_ID,
          threadId: SUPERVISOR_THREAD_ID,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "FirstMateCommandRejectedError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("rejects an unknown topic before dispatching anything", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("firstmate_update_topic", { topicId: "topic-missing", stage: "testing" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "FirstMateCommandRejectedError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("opens a decision with a recommendation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("firstmate_open_decision", {
        topicId: TOPIC_ID,
        question: "Which limiter should auth use?",
        options: [
          { id: "a", label: "Token bucket", description: "Bursty but simple." },
          { id: "b", label: "Sliding window", description: "Smoother, more state." },
        ],
        recommendedOptionId: "a",
        blocking: true,
      });
      expect(result).toMatchObject({ topicId: TOPIC_ID, optionIds: ["a", "b"], blocking: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "firstmate.decision.open",
          decisionId: result.decisionId,
          topicId: TOPIC_ID,
          recommendedOptionId: "a",
          blocking: true,
          source: { kind: "firstmate", sourceId: SUPERVISOR_THREAD_ID },
        },
      ]);
    }),
  );

  it.effect("refuses a decision the user cannot choose between", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const single = yield* harness
        .call("firstmate_open_decision", {
          topicId: TOPIC_ID,
          question: "Proceed?",
          options: [{ id: "a", label: "Yes", description: "Go ahead." }],
          blocking: false,
        })
        .pipe(Effect.flip);
      expect(single).toMatchObject({ _tag: "FirstMateCommandRejectedError" });

      const strayRecommendation = yield* harness
        .call("firstmate_open_decision", {
          topicId: TOPIC_ID,
          question: "Which limiter?",
          options: [
            { id: "a", label: "Token bucket", description: "Bursty but simple." },
            { id: "b", label: "Sliding window", description: "Smoother, more state." },
          ],
          recommendedOptionId: "c",
          blocking: false,
        })
        .pipe(Effect.flip);
      expect(strayRecommendation).toMatchObject({ _tag: "FirstMateCommandRejectedError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("lists live topics with what is already waiting on the user", () =>
    Effect.gen(function* () {
      const laterTopicId = FirstMateTopicId.make("topic-2");
      const doneTopicId = FirstMateTopicId.make("topic-done");
      const harness = yield* makeHarness({
        firstMate: makeWorkspace({
          // Selected work often finishes before the user picks the next topic.
          selectedTopicId: doneTopicId,
          topics: [
            makeTopic({ responsibleAgentId: "codex", threadId: WORKER_THREAD_ID }),
            makeTopic({
              id: laterTopicId,
              title: "Session limits",
              stage: "implementation",
              updatedAt: "2026-08-02T00:00:00.000Z",
            }),
            makeTopic({ id: doneTopicId, title: "Shipped", stage: "completed" }),
          ],
          decisions: [
            makePendingDecision("decision-advisory", laterTopicId),
            makePendingDecision("decision-1", TOPIC_ID, true),
            { ...makePendingDecision("decision-resolved", TOPIC_ID), status: "resolved" },
          ],
        }),
      });

      const result = yield* harness.call("firstmate_list_topics", {});

      // Completed topics are history, and the newest live topic comes first.
      expect(result.topics.map((topic) => topic.topicId)).toEqual([laterTopicId, TOPIC_ID]);
      // Routing destination is reported even though that topic is filtered out.
      expect(result.selectedTopicId).toBe(doneTopicId);
      expect(result.topics[1]).toMatchObject({
        topicId: TOPIC_ID,
        title: "Rate limits",
        stage: "research",
        threadId: WORKER_THREAD_ID,
        responsibleAgentId: "codex",
        pendingDecisionCount: 1,
      });
      expect(result.topics[0]?.pendingDecisionCount).toBe(1);
      // Resolved decisions are gone and the blocking one is reported first.
      expect(result.pendingDecisions).toEqual([
        {
          decisionId: "decision-1",
          topicId: TOPIC_ID,
          question: "Question decision-1",
          blocking: true,
        },
        {
          decisionId: "decision-advisory",
          topicId: laterTopicId,
          question: "Question decision-advisory",
          blocking: false,
        },
      ]);
      expect(result.truncated).toBe(false);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("returns completed topics only when that stage is asked for", () =>
    Effect.gen(function* () {
      const doneTopicId = FirstMateTopicId.make("topic-done");
      const harness = yield* makeHarness({
        firstMate: makeWorkspace({
          topics: [makeTopic(), makeTopic({ id: doneTopicId, stage: "completed" })],
        }),
      });

      const completed = yield* harness.call("firstmate_list_topics", { stage: "completed" });
      expect(completed.topics.map((topic) => topic.topicId)).toEqual([doneTopicId]);

      const research = yield* harness.call("firstmate_list_topics", { stage: "research" });
      expect(research.topics.map((topic) => topic.topicId)).toEqual([TOPIC_ID]);
    }),
  );

  it.effect("caps a large workspace and says so", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        firstMate: makeWorkspace({
          topics: Array.from({ length: FIRST_MATE_TOPIC_LIST_LIMIT + 5 }, (_unused, index) =>
            makeTopic({
              id: FirstMateTopicId.make(`topic-${index}`),
              // Ascending timestamps, so the newest ids must survive the cap.
              updatedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
            }),
          ),
        }),
      });

      const result = yield* harness.call("firstmate_list_topics", {});
      expect(result.topics).toHaveLength(FIRST_MATE_TOPIC_LIST_LIMIT);
      expect(result.truncated).toBe(true);
      expect(result.topics[0]?.topicId).toBe(`topic-${FIRST_MATE_TOPIC_LIST_LIMIT + 4}`);
    }),
  );

  it.effect("refuses to read topics outside the supervisor thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("firstmate_list_topics", {}, WORKER_THREAD_ID)
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "FirstMateSupervisorOnlyError",
        threadId: WORKER_THREAD_ID,
      });
    }),
  );

  it.effect("surfaces the decider's rejection text", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        reject: () =>
          new OrchestrationCommandInvariantError({
            commandType: "firstmate.topic.update",
            detail: "FirstMate command rejected: topic-not-found.",
          }),
      });
      const error = yield* harness
        .call("firstmate_update_topic", { topicId: TOPIC_ID, stage: "testing" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "FirstMateCommandRejectedError",
        detail: "FirstMate command rejected: topic-not-found.",
      });
    }),
  );

  it.effect("queues a supervisor message on the thread the topic is delegated to", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        firstMate: makeWorkspace({ topics: [makeTopic({ threadId: WORKER_THREAD_ID })] }),
      });
      const result = yield* harness.call("firstmate_send_to_topic", {
        topicId: TOPIC_ID,
        text: "Use the account-scoped limiter.",
      });
      expect(result).toMatchObject({ topicId: TOPIC_ID, threadId: WORKER_THREAD_ID });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.queued-message.enqueue",
          threadId: WORKER_THREAD_ID,
          queuedMessageId: result.queuedMessageId,
          dispatchTiming: "after-current-turn",
          message: { role: "user", text: "Use the account-scoped limiter." },
        },
      ]);
    }),
  );

  it.effect("refuses to send to a topic nobody is working on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("firstmate_send_to_topic", { topicId: TOPIC_ID, text: "Anything." })
        .pipe(Effect.flip);
      expect(error._tag).toBe("FirstMateCommandRejectedError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("refuses to send to a delegated thread that is archived or gone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        firstMate: makeWorkspace({
          topics: [makeTopic({ threadId: ThreadId.make("thread-archived") })],
        }),
      });
      const error = yield* harness
        .call("firstmate_send_to_topic", { topicId: TOPIC_ID, text: "Anything." })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "FirstMateCommandRejectedError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("refuses to send to an unknown topic rather than to a named thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("firstmate_send_to_topic", { topicId: "topic-unknown", text: "Anything." })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "FirstMateCommandRejectedError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("refuses to send outside the supervisor thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        firstMate: makeWorkspace({ topics: [makeTopic({ threadId: WORKER_THREAD_ID })] }),
      });
      const error = yield* harness
        .call("firstmate_send_to_topic", { topicId: TOPIC_ID, text: "Anything." }, WORKER_THREAD_ID)
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "FirstMateSupervisorOnlyError",
        threadId: WORKER_THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );
});
