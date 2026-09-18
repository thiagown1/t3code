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
  type FirstMateDecision,
  type FirstMateDecisionSource,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

  it.effect("never answers a decision that came from a native provider request", () =>
    Effect.gen(function* () {
      for (const kind of ["approval", "user-input"] as const) {
        const source: FirstMateDecisionSource = {
          kind,
          requestId: ApprovalRequestId.make("request-1"),
        };
        const dispatched = yield* deliver({ decision: makeDecision({ source }) });
        expect(dispatched).toEqual([]);
      }
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
