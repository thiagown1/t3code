import {
  ApprovalRequestId,
  CommandId,
  CorrelationId,
  EventId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type FirstMateDecision,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FIRST_MATE_CONTINUE_MESSAGE } from "@t3tools/shared/firstMateTurnReview";

import { processDecisionResolved } from "./FirstMateDecisionDeliveryReactor.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const SUPERVISOR_THREAD_ID = ThreadId.make("thread-supervisor");
const DECISION_ID = FirstMateDecisionId.make("decision-1");

function makeDecision(overrides: Partial<FirstMateDecision> = {}): FirstMateDecision {
  return {
    id: DECISION_ID,
    projectId: PROJECT_ID,
    topicId: FirstMateTopicId.make("topic-1"),
    source: { kind: "firstmate", sourceId: SUPERVISOR_THREAD_ID },
    question: "Rate limit by IP or by account?",
    options: [
      { id: "ip", label: "By IP", description: "Cheap, but shared offices collide." },
      { id: "account", label: "By account", description: "Fairer, needs an auth lookup." },
    ],
    recommendedOptionId: "account",
    selectedOptionId: "account",
    blocking: true,
    status: "resolved",
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: NOW,
    ...overrides,
  };
}

function makeProject(decisions: ReadonlyArray<FirstMateDecision>): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    firstMate: {
      projectId: PROJECT_ID,
      supervisorThreadId: SUPERVISOR_THREAD_ID,
      selectedTopicId: null,
      topics: [],
      decisions,
      routingReceipts: [],
      routingEvaluationMode: "off",
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(id: ThreadId, projectId: ProjectId): OrchestrationThreadShell {
  return {
    id,
    projectId,
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

function resolvedEvent(selectedOptionId: string | null): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make("evt-decision-resolved"),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "firstmate.domain-event",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-decision-resolved"),
    causationEventId: null,
    correlationId: CorrelationId.make("cmd-decision-resolved"),
    metadata: {},
    payload: {
      type: "firstmate.decision-resolved",
      projectId: PROJECT_ID,
      decisionId: DECISION_ID,
      selectedOptionId,
      occurredAt: NOW,
    },
  };
}

/** Runs one resolved decision through delivery and reports what it dispatched. */
function deliver(input: {
  readonly decision?: FirstMateDecision | null;
  readonly selectedOptionId?: string | null;
  readonly liveThreads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly activitiesByThread?: Readonly<
    Record<string, ReadonlyArray<OrchestrationThreadActivity>>
  >;
}) {
  return Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const decision = input.decision === undefined ? makeDecision() : input.decision;
    const liveThreads = input.liveThreads ?? [makeThread(SUPERVISOR_THREAD_ID, PROJECT_ID)];
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 2 };
        }),
    } as unknown as OrchestrationEngineShape;
    const snapshots = {
      getProjectShellById: () =>
        Effect.succeed(Option.some(makeProject(decision === null ? [] : [decision]))),
      getThreadShellById: (threadId: ThreadId) => {
        const match = liveThreads.find((thread) => thread.id === threadId);
        return Effect.succeed(match === undefined ? Option.none() : Option.some(match));
      },
      getThreadDetailById: (threadId: ThreadId) => {
        const match = liveThreads.find((thread) => thread.id === threadId);
        if (match === undefined) return Effect.succeed(Option.none());
        return Effect.succeed(
          Option.some({ activities: input.activitiesByThread?.[threadId] ?? [] }),
        );
      },
    } as unknown as ProjectionSnapshotQuery["Service"];

    const event = resolvedEvent(
      input.selectedOptionId === undefined ? "account" : input.selectedOptionId,
    );
    yield* processDecisionResolved({
      event: event as Extract<OrchestrationEvent, { type: "firstmate.domain-event" }> & {
        payload: { type: "firstmate.decision-resolved" };
      },
      engine,
      snapshots,
    });
    return dispatched;
  });
}

describe("FirstMate decision delivery", () => {
  it.effect("queues the answer on the thread that opened the decision", () =>
    Effect.gen(function* () {
      const dispatched = yield* deliver({});
      expect(dispatched).toHaveLength(1);
      const command = dispatched[0]!;
      expect(command).toMatchObject({
        type: "thread.queued-message.enqueue",
        threadId: SUPERVISOR_THREAD_ID,
        dispatchTiming: "after-current-turn",
      });
      const text = command.type === "thread.queued-message.enqueue" ? command.message.text : "";
      expect(text).toContain("Rate limit by IP or by account?");
      expect(text).toContain("By account");
      expect(text).toContain("Fairer, needs an auth lookup.");
      expect(text).not.toContain("By IP");
    }),
  );

  it.effect("derives ids from the decision so a replayed event cannot answer twice", () =>
    Effect.gen(function* () {
      const first = (yield* deliver({}))[0]!;
      const second = (yield* deliver({}))[0]!;
      expect(first).toEqual(second);
      expect(first.commandId).toContain(DECISION_ID);
    }),
  );

  it.effect("refuses when the asking thread is archived, deleted or unknown", () =>
    Effect.gen(function* () {
      const dispatched = yield* deliver({ liveThreads: [] });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses when the asking thread belongs to another project", () =>
    Effect.gen(function* () {
      const dispatched = yield* deliver({
        liveThreads: [makeThread(SUPERVISOR_THREAD_ID, OTHER_PROJECT_ID)],
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses when the recorded choice names no known option", () =>
    Effect.gen(function* () {
      expect(yield* deliver({ selectedOptionId: null })).toEqual([]);
      expect(yield* deliver({ selectedOptionId: "invented" })).toEqual([]);
    }),
  );

  it.effect("refuses when the decision is not in the project workspace", () =>
    Effect.gen(function* () {
      expect(yield* deliver({ decision: null })).toEqual([]);
    }),
  );
});

const WORKER_THREAD_ID = ThreadId.make("thread-worker");
const OTHER_WORKER_THREAD_ID = ThreadId.make("thread-other-worker");
const REQUEST_ID = ApprovalRequestId.make("request-worker");
const OTHER_REQUEST_ID = ApprovalRequestId.make("request-other-worker");

function approvalRequested(input: {
  readonly requestId: ApprovalRequestId;
  readonly command: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${input.requestId}`),
    tone: "approval",
    kind: "approval.requested",
    summary: "Command approval requested",
    payload: {
      requestId: input.requestId,
      requestKind: "command",
      requestType: "tool_command",
      detail: input.command,
      options: [
        { decision: "accept", label: "Yes, run it" },
        { decision: "acceptAlways", label: "Yes, and never ask again" },
        { decision: "decline", label: "No" },
      ],
    },
    turnId: null,
    createdAt: NOW,
  } as OrchestrationThreadActivity;
}

function userInputRequested(requestId: ApprovalRequestId): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${requestId}`),
    tone: "info",
    kind: "user-input.requested",
    summary: "User input requested",
    payload: {
      requestId,
      questions: [
        {
          id: "storage",
          header: "Storage",
          question: "Where should the cache live?",
          options: [
            { label: "In memory", description: "Fast, lost on restart." },
            { label: "On disk", description: "Survives a restart.", value: "disk" },
          ],
        },
      ],
    },
    turnId: null,
    createdAt: NOW,
  } as OrchestrationThreadActivity;
}

function requestDecision(overrides: Partial<FirstMateDecision> = {}): FirstMateDecision {
  return makeDecision({
    source: { kind: "approval", requestId: REQUEST_ID, threadId: WORKER_THREAD_ID },
    question: "Command approval requested: rm -rf ./build",
    options: [
      { id: "accept", label: "Yes, run it", description: "Allow this once." },
      {
        id: "acceptAlways",
        label: "Yes, and never ask again",
        description: "Allow this every time from now on.",
      },
      { id: "decline", label: "No", description: "Refuse this request." },
    ],
    recommendedOptionId: null,
    selectedOptionId: "accept",
    ...overrides,
  });
}

const workerRequestActivities = {
  [WORKER_THREAD_ID]: [approvalRequested({ requestId: REQUEST_ID, command: "rm -rf ./build" })],
};

describe("FirstMate decision delivery to a provider request", () => {
  it.effect("answers the exact request on the thread named by the source", () =>
    Effect.gen(function* () {
      // Two threads, each blocked on its own request. A delivery that searched
      // threads for a matching request instead of using the source's thread,
      // or that answered whichever request it found first, fails here.
      const dispatched = yield* deliver({
        decision: requestDecision(),
        selectedOptionId: "accept",
        liveThreads: [
          makeThread(WORKER_THREAD_ID, PROJECT_ID),
          makeThread(OTHER_WORKER_THREAD_ID, PROJECT_ID),
        ],
        activitiesByThread: {
          [OTHER_WORKER_THREAD_ID]: [
            approvalRequested({ requestId: OTHER_REQUEST_ID, command: "git push --force" }),
          ],
          ...workerRequestActivities,
        },
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.approval.respond",
        commandId: `server:firstmate-request-answer:${DECISION_ID}`,
        threadId: WORKER_THREAD_ID,
        requestId: REQUEST_ID,
        decision: "accept",
      });
    }),
  );

  it.effect("maps each card option onto the provider literal it was built from", () =>
    Effect.gen(function* () {
      for (const optionId of ["accept", "acceptAlways", "decline"] as const) {
        const dispatched = yield* deliver({
          decision: requestDecision({ selectedOptionId: optionId }),
          selectedOptionId: optionId,
          liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
          activitiesByThread: workerRequestActivities,
        });
        expect(dispatched[0]).toMatchObject({
          type: "thread.approval.respond",
          decision: optionId,
        });
      }
    }),
  );

  it.effect("rebuilds a user-input answer keyed by the question it came from", () =>
    Effect.gen(function* () {
      const decision = makeDecision({
        source: { kind: "user-input", requestId: REQUEST_ID, threadId: WORKER_THREAD_ID },
        question: "Where should the cache live?",
        options: [
          { id: "answer:0", label: "In memory", description: "Fast, lost on restart." },
          { id: "answer:1", label: "On disk", description: "Survives a restart." },
        ],
        recommendedOptionId: null,
        selectedOptionId: "answer:1",
      });
      const dispatched = yield* deliver({
        decision,
        selectedOptionId: "answer:1",
        liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
        activitiesByThread: { [WORKER_THREAD_ID]: [userInputRequested(REQUEST_ID)] },
      });
      expect(dispatched[0]).toMatchObject({
        type: "thread.user-input.respond",
        threadId: WORKER_THREAD_ID,
        requestId: REQUEST_ID,
        // `value ?? label`: the same answer any client would have sent.
        answers: { storage: "disk" },
      });
    }),
  );

  it.effect("refuses a decision whose source carries no thread", () =>
    Effect.gen(function* () {
      const dispatched = yield* deliver({
        decision: requestDecision({
          source: { kind: "approval", requestId: REQUEST_ID, threadId: null },
        }),
        selectedOptionId: "accept",
        liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
        activitiesByThread: workerRequestActivities,
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses when the source thread is archived, deleted or unknown", () =>
    Effect.gen(function* () {
      const dispatched = yield* deliver({
        decision: requestDecision(),
        selectedOptionId: "accept",
        liveThreads: [makeThread(OTHER_WORKER_THREAD_ID, PROJECT_ID)],
        activitiesByThread: {
          [OTHER_WORKER_THREAD_ID]: [
            approvalRequested({ requestId: REQUEST_ID, command: "rm -rf ./build" }),
          ],
        },
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses when the source thread belongs to another project", () =>
    Effect.gen(function* () {
      const dispatched = yield* deliver({
        decision: requestDecision(),
        selectedOptionId: "accept",
        liveThreads: [makeThread(WORKER_THREAD_ID, OTHER_PROJECT_ID)],
        activitiesByThread: workerRequestActivities,
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses when the request was already answered in the thread", () =>
    Effect.gen(function* () {
      const request = approvalRequested({ requestId: REQUEST_ID, command: "rm -rf ./build" });
      const dispatched = yield* deliver({
        decision: requestDecision(),
        selectedOptionId: "accept",
        liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
        activitiesByThread: {
          [WORKER_THREAD_ID]: [
            request,
            {
              ...request,
              id: EventId.make("activity-resolved"),
              kind: "approval.resolved",
              summary: "Approval resolved",
              payload: { requestId: REQUEST_ID, decision: "decline" },
            } as OrchestrationThreadActivity,
          ],
        },
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("answers the card's own request when the thread has several open", () =>
    Effect.gen(function* () {
      // The thread is blocked on two questions at once, and both offer an
      // answer with the same label. Reading the reply off the wrong one sends
      // the user's pick to a question they never saw: the answers record would
      // be keyed `region` instead of `storage`.
      const other = {
        ...userInputRequested(OTHER_REQUEST_ID),
        payload: {
          requestId: OTHER_REQUEST_ID,
          questions: [
            {
              id: "region",
              header: "Region",
              question: "Which region should this deploy to?",
              options: [
                { label: "In memory", description: "Not a region at all." },
                { label: "eu-west-1", description: "Ireland." },
              ],
            },
          ],
        },
      } as OrchestrationThreadActivity;
      const dispatched = yield* deliver({
        decision: makeDecision({
          source: { kind: "user-input", requestId: REQUEST_ID, threadId: WORKER_THREAD_ID },
          question: "Where should the cache live?",
          options: [
            { id: "answer:0", label: "In memory", description: "Fast, lost on restart." },
            { id: "answer:1", label: "On disk", description: "Survives a restart." },
          ],
          recommendedOptionId: null,
          selectedOptionId: "answer:0",
        }),
        selectedOptionId: "answer:0",
        liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
        activitiesByThread: {
          [WORKER_THREAD_ID]: [other, userInputRequested(REQUEST_ID)],
        },
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.user-input.respond",
        requestId: REQUEST_ID,
        answers: { storage: "In memory" },
      });
    }),
  );

  it.effect("refuses when the live request is of the other kind", () =>
    Effect.gen(function* () {
      const dispatched = yield* deliver({
        decision: requestDecision(),
        selectedOptionId: "accept",
        liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
        activitiesByThread: { [WORKER_THREAD_ID]: [userInputRequested(REQUEST_ID)] },
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses an option the live request does not offer", () =>
    Effect.gen(function* () {
      // `cancel` is a valid ProviderApprovalDecision, but this request never
      // offered it, so it is not an answer the user was shown.
      const dispatched = yield* deliver({
        decision: requestDecision({
          options: [
            { id: "accept", label: "Yes, run it", description: "Allow this once." },
            { id: "cancel", label: "Abort", description: "Stop the request." },
          ],
          selectedOptionId: "cancel",
        }),
        selectedOptionId: "cancel",
        liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
        activitiesByThread: workerRequestActivities,
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses when the card's label no longer matches the live request", () =>
    Effect.gen(function* () {
      // A card built from a different payload than the one being answered.
      // Answering anyway would authorize a command under a label the user
      // never saw.
      const dispatched = yield* deliver({
        decision: requestDecision({
          options: [
            { id: "accept", label: "Deploy to production", description: "Allow this once." },
            { id: "decline", label: "No", description: "Refuse this request." },
          ],
        }),
        selectedOptionId: "accept",
        liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
        activitiesByThread: workerRequestActivities,
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("derives the command id from the decision so a replay cannot answer twice", () =>
    Effect.gen(function* () {
      const run = () =>
        deliver({
          decision: requestDecision(),
          selectedOptionId: "accept",
          liveThreads: [makeThread(WORKER_THREAD_ID, PROJECT_ID)],
          activitiesByThread: workerRequestActivities,
        });
      const first = (yield* run())[0]!;
      const second = (yield* run())[0]!;
      expect(first.commandId).toEqual(second.commandId);
      expect(first.commandId).toContain(DECISION_ID);
    }),
  );
});

describe("FirstMate turn review delivery", () => {
  const REVIEWED_THREAD_ID = ThreadId.make("thread-reviewed");
  const reviewDecision = makeDecision({
    topicId: null,
    source: { kind: "turn-review", threadId: REVIEWED_THREAD_ID, turnId: TurnId.make("turn-9") },
    question: "Should I also update the docs?",
    options: [
      { id: "continue", label: "Continue as proposed", description: "Queue a continue." },
      { id: "mark-done", label: "Mark done", description: "Close the thread as done." },
      { id: "answer-myself", label: "I'll answer in the thread", description: "Nothing." },
    ],
    recommendedOptionId: "continue",
  });
  const run = (selectedOptionId: string) =>
    deliver({
      decision: reviewDecision,
      selectedOptionId,
      liveThreads: [makeThread(REVIEWED_THREAD_ID, PROJECT_ID)],
    });

  it.effect("continue queues the fixed continue message on the reviewed thread", () =>
    Effect.gen(function* () {
      const dispatched = yield* run("continue");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.queued-message.enqueue",
        threadId: REVIEWED_THREAD_ID,
        dispatchTiming: "after-current-turn",
        message: { text: FIRST_MATE_CONTINUE_MESSAGE },
      });
    }),
  );

  it.effect("mark done sets the thread's delivery status", () =>
    Effect.gen(function* () {
      expect(yield* run("mark-done")).toMatchObject([
        { type: "thread.meta.update", threadId: REVIEWED_THREAD_ID, deliveryStatus: "done" },
      ]);
    }),
  );

  it.effect("answering myself only resolves the card", () =>
    Effect.gen(function* () {
      expect(yield* run("answer-myself")).toEqual([]);
    }),
  );
});
