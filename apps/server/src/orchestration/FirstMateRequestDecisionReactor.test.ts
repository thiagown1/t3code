import {
  ApprovalRequestId,
  EventId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FirstMateDecision,
  type FirstMateTopic,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  firstMateBackfillThreadIds,
  FirstMateRequestDecisionReactor,
  layer,
  reconcileThreadRequestDecisions,
} from "./FirstMateRequestDecisionReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "./Services/RuntimeReceiptBus.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const SUPERVISOR_THREAD_ID = ThreadId.make("thread-supervisor");
const WORKER_THREAD_ID = ThreadId.make("thread-worker");
const OTHER_THREAD_ID = ThreadId.make("thread-other");
const TOPIC_ID = FirstMateTopicId.make("topic-1");
const REQUEST_ID = ApprovalRequestId.make("request-1");
const EXPECTED_DECISION_ID = FirstMateDecisionId.make(
  `fm-request:${WORKER_THREAD_ID}:${REQUEST_ID}`,
);

function makeTopic(overrides: Partial<FirstMateTopic> = {}): FirstMateTopic {
  return {
    id: TOPIC_ID,
    projectId: PROJECT_ID,
    title: "Rate limiter",
    summary: "Stop the API falling over under burst load.",
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

function makeThread(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
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
    hasPendingApprovals: true,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeProject(input: {
  readonly topics: ReadonlyArray<FirstMateTopic>;
  readonly decisions: ReadonlyArray<FirstMateDecision>;
  readonly supervisorThreadId?: ThreadId | null;
  readonly withWorkspace?: boolean;
}): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    firstMate:
      input.withWorkspace === false
        ? null
        : {
            projectId: PROJECT_ID,
            supervisorThreadId:
              input.supervisorThreadId === undefined
                ? SUPERVISOR_THREAD_ID
                : input.supervisorThreadId,
            selectedTopicId: null,
            topics: input.topics,
            decisions: input.decisions,
            routingReceipts: [],
            routingEvaluationMode: "off",
            updatedAt: NOW,
          },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function approvalRequested(requestId: ApprovalRequestId): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${requestId}`),
    tone: "approval",
    kind: "approval.requested",
    summary: "Command approval requested",
    payload: {
      requestId,
      requestKind: "command",
      requestType: "tool_command",
      detail: "rm -rf ./build",
      options: [
        { decision: "accept", label: "Yes, run it" },
        { decision: "decline", label: "No" },
      ],
    },
    turnId: null,
    createdAt: NOW,
  } as OrchestrationThreadActivity;
}

function approvalResolved(requestId: ApprovalRequestId): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-resolved-${requestId}`),
    tone: "approval",
    kind: "approval.resolved",
    summary: "Approval resolved",
    payload: { requestId, decision: "accept" },
    turnId: null,
    createdAt: NOW,
  } as OrchestrationThreadActivity;
}

function openRequestDecision(overrides: Partial<FirstMateDecision> = {}): FirstMateDecision {
  return {
    id: EXPECTED_DECISION_ID,
    projectId: PROJECT_ID,
    topicId: TOPIC_ID,
    source: { kind: "approval", requestId: REQUEST_ID, threadId: WORKER_THREAD_ID },
    question: "Command approval requested: rm -rf ./build",
    options: [
      { id: "accept", label: "Yes, run it", description: "Allow this once." },
      { id: "decline", label: "No", description: "Refuse this request." },
    ],
    recommendedOptionId: null,
    selectedOptionId: null,
    blocking: true,
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    ...overrides,
  };
}

/** Runs one reconcile pass and reports what it dispatched. */
function reconcile(input: {
  readonly threadId?: ThreadId;
  readonly liveThreads?: ReadonlyArray<ThreadId>;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
  readonly project?: OrchestrationProjectShell | null;
}) {
  return Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const threadId = input.threadId ?? WORKER_THREAD_ID;
    const liveThreads = input.liveThreads ?? [WORKER_THREAD_ID, SUPERVISOR_THREAD_ID];
    const project =
      input.project === undefined
        ? makeProject({ topics: [makeTopic()], decisions: [] })
        : input.project;
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 2 };
        }),
    } as unknown as OrchestrationEngineShape;
    const snapshots = {
      getThreadShellById: (id: ThreadId) =>
        Effect.succeed(liveThreads.includes(id) ? Option.some(makeThread(id)) : Option.none()),
      getProjectShellById: () =>
        Effect.succeed(project === null ? Option.none() : Option.some(project)),
      getThreadDetailById: () =>
        Effect.succeed(Option.some({ activities: input.activities ?? [] })),
    } as unknown as ProjectionSnapshotQuery["Service"];

    const result = yield* reconcileThreadRequestDecisions({ threadId, engine, snapshots });
    return { dispatched, result };
  });
}

describe("FirstMate request decision projection", () => {
  it.effect("opens one blocking decision for a pending approval on a delegated thread", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* reconcile({ activities: [approvalRequested(REQUEST_ID)] });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "firstmate.decision.open",
        projectId: PROJECT_ID,
        decisionId: EXPECTED_DECISION_ID,
        topicId: TOPIC_ID,
        source: { kind: "approval", requestId: REQUEST_ID, threadId: WORKER_THREAD_ID },
        blocking: true,
        // Never nudge the user toward authorizing something.
        recommendedOptionId: null,
      });
      const command = dispatched[0]!;
      const question = command.type === "firstmate.decision.open" ? command.question : "";
      // The card has to say what is being asked, not just that something is.
      expect(question).toContain("rm -rf ./build");
    }),
  );

  it.effect("never opens a second decision for the same request", () =>
    Effect.gen(function* () {
      const activities = [approvalRequested(REQUEST_ID)];
      const first = yield* reconcile({ activities });
      expect(first.dispatched).toHaveLength(1);

      // The workspace now holds the card the first pass opened.
      const second = yield* reconcile({
        activities,
        project: makeProject({ topics: [makeTopic()], decisions: [openRequestDecision()] }),
      });
      expect(second.dispatched).toEqual([]);
      expect(second.result.outcome).toBe("reconciled");
    }),
  );

  it.effect("cancels the card when the request is answered inside the thread", () =>
    Effect.gen(function* () {
      // Both shapes of card leave the same way: the one a topic owns and the
      // one belonging only to the thread that asked.
      for (const topics of [[makeTopic()], []]) {
        const { dispatched } = yield* reconcile({
          activities: [approvalRequested(REQUEST_ID), approvalResolved(REQUEST_ID)],
          project: makeProject({
            topics,
            decisions: [openRequestDecision(topics.length === 0 ? { topicId: null } : {})],
          }),
        });
        expect(dispatched).toEqual([
          expect.objectContaining({
            type: "firstmate.decision.cancel",
            projectId: PROJECT_ID,
            decisionId: EXPECTED_DECISION_ID,
          }),
        ]);
      }
    }),
  );

  it.effect("leaves already resolved and cancelled cards alone", () =>
    Effect.gen(function* () {
      for (const status of ["resolved", "cancelled"] as const) {
        const { dispatched } = yield* reconcile({
          activities: [approvalRequested(REQUEST_ID), approvalResolved(REQUEST_ID)],
          project: makeProject({
            topics: [makeTopic()],
            decisions: [openRequestDecision({ status, resolvedAt: NOW })],
          }),
        });
        expect(dispatched).toEqual([]);
      }
    }),
  );

  it.effect("does not re-raise a card the user dismissed while the request is still open", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* reconcile({
        activities: [approvalRequested(REQUEST_ID)],
        project: makeProject({
          topics: [makeTopic()],
          decisions: [openRequestDecision({ status: "cancelled", resolvedAt: NOW })],
        }),
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("keeps reconciling the rest of the pass when one command is rejected", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationCommand[] = [];
      const staleRequestId = ApprovalRequestId.make("request-stale");
      const staleDecisionId = FirstMateDecisionId.make(
        `fm-request:${WORKER_THREAD_ID}:${staleRequestId}`,
      );
      const engine = {
        dispatch: (command: OrchestrationCommand) =>
          command.type === "firstmate.decision.open"
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "decision-already-exists",
                }),
              )
            : Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 2 };
              }),
      } as unknown as OrchestrationEngineShape;
      const snapshots = {
        getThreadShellById: (id: ThreadId) => Effect.succeed(Option.some(makeThread(id))),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some(
              makeProject({
                topics: [makeTopic()],
                decisions: [
                  openRequestDecision({
                    id: staleDecisionId,
                    source: {
                      kind: "approval",
                      requestId: staleRequestId,
                      threadId: WORKER_THREAD_ID,
                    },
                  }),
                ],
              }),
            ),
          ),
        getThreadDetailById: () =>
          Effect.succeed(Option.some({ activities: [approvalRequested(REQUEST_ID)] })),
      } as unknown as ProjectionSnapshotQuery["Service"];

      const result = yield* reconcileThreadRequestDecisions({
        threadId: WORKER_THREAD_ID,
        engine,
        snapshots,
      });
      // The open was rejected, but the stale card still left the inbox.
      expect(result.openedRequestIds).toEqual([]);
      expect(result.cancelledDecisionIds).toEqual([staleDecisionId]);
      expect(dispatched).toHaveLength(1);
    }),
  );

  it.effect("never makes the supervisor thread a source of its own inbox", () =>
    Effect.gen(function* () {
      const { dispatched, result } = yield* reconcile({
        threadId: SUPERVISOR_THREAD_ID,
        activities: [approvalRequested(REQUEST_ID)],
        project: makeProject({
          topics: [makeTopic({ threadId: SUPERVISOR_THREAD_ID })],
          decisions: [],
        }),
      });
      expect(dispatched).toEqual([]);
      expect(result.outcome).toBe("skipped");
    }),
  );

  it.effect("opens an unowned card for a thread no FirstMate topic is delegated to", () =>
    Effect.gen(function* () {
      // The case the inbox exists for: threads running with nothing delegated,
      // one of them blocked on an approval.
      const { dispatched, result } = yield* reconcile({
        activities: [approvalRequested(REQUEST_ID)],
        project: makeProject({ topics: [makeTopic({ threadId: null })], decisions: [] }),
      });
      expect(dispatched).toEqual([
        expect.objectContaining({
          type: "firstmate.decision.open",
          decisionId: EXPECTED_DECISION_ID,
          topicId: null,
          source: { kind: "approval", requestId: REQUEST_ID, threadId: WORKER_THREAD_ID },
          recommendedOptionId: null,
          blocking: true,
        }),
      ]);
      expect(result.outcome).toBe("reconciled");
    }),
  );

  it.effect("keeps a live card when its topic is delegated to another thread", () =>
    Effect.gen(function* () {
      const { dispatched, result } = yield* reconcile({
        // The request is still open on the thread. Delegation moving used to
        // orphan this card; it no longer decides anything, so taking the
        // question away here would hide work still blocked on the user.
        activities: [approvalRequested(REQUEST_ID)],
        project: makeProject({
          topics: [makeTopic({ threadId: OTHER_THREAD_ID })],
          decisions: [openRequestDecision()],
        }),
      });
      expect(dispatched).toEqual([]);
      expect(result.outcome).toBe("reconciled");
    }),
  );

  it.effect("ignores projects with no FirstMate workspace", () =>
    Effect.gen(function* () {
      const { dispatched, result } = yield* reconcile({
        activities: [approvalRequested(REQUEST_ID)],
        project: makeProject({ topics: [], decisions: [], withWorkspace: false }),
      });
      expect(dispatched).toEqual([]);
      expect(result.outcome).toBe("skipped");
    }),
  );

  it.effect("ignores archived, deleted and unknown threads", () =>
    Effect.gen(function* () {
      const { dispatched, result } = yield* reconcile({
        liveThreads: [SUPERVISOR_THREAD_ID],
        activities: [approvalRequested(REQUEST_ID)],
      });
      expect(dispatched).toEqual([]);
      expect(result.outcome).toBe("skipped");
    }),
  );

  it.effect("skips a request it cannot state exactly rather than approximating it", () =>
    Effect.gen(function* () {
      const optionless = {
        ...approvalRequested(REQUEST_ID),
        payload: { requestId: REQUEST_ID, requestKind: "command", detail: "rm -rf ./build" },
      } as OrchestrationThreadActivity;
      const { dispatched, result } = yield* reconcile({ activities: [optionless] });
      expect(dispatched).toEqual([]);
      expect(result.outcome).toBe("reconciled");
    }),
  );
});

function topicDelegated(threadId: ThreadId | null): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make(`evt-delegated-${threadId ?? "none"}`),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "firstmate.domain-event",
    payload: {
      type: "firstmate.topic-delegated",
      projectId: PROJECT_ID,
      topicId: TOPIC_ID,
      threadId,
      responsibleAgentId: "codex",
      occurredAt: NOW,
    },
  } as OrchestrationEvent;
}

/**
 * The reactor with its stream and receipt bus queue-backed on both sides, so a
 * test waits on the pass it caused instead of on a clock.
 */
const makeHarness = Effect.fn("makeFirstMateRequestDecisionHarness")(function* (options: {
  readonly project: OrchestrationProjectShell;
  readonly activities?: Readonly<Record<string, ReadonlyArray<OrchestrationThreadActivity>>>;
  /**
   * What the shell snapshot a backfill scans reports. Empty by default, so a
   * test about one trigger is not also a test of the one that runs at start.
   */
  readonly shellThreads?: ReadonlyArray<OrchestrationThreadShell>;
}) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const project = yield* Ref.make(options.project);
  const events = yield* Queue.unbounded<OrchestrationEvent>();
  const receipts = yield* Queue.unbounded<OrchestrationRuntimeReceipt>();

  const snapshots = {
    getThreadShellById: (id: ThreadId) => Effect.succeed(Option.some(makeThread(id))),
    getProjectShellById: () => Effect.map(Ref.get(project), Option.some),
    getThreadDetailById: (id: ThreadId) =>
      Effect.succeed(Option.some({ activities: options.activities?.[id] ?? [] })),
    getShellSnapshot: () =>
      Effect.map(Ref.get(project), (current) => ({
        projects: [current],
        threads: options.shellThreads ?? [],
      })),
  } as unknown as ProjectionSnapshotQuery["Service"];

  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, snapshots),
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
      streamDomainEvents: Stream.fromQueue(events),
    } as unknown as OrchestrationEngineShape),
    Layer.succeed(RuntimeReceiptBus, {
      publish: (receipt: OrchestrationRuntimeReceipt) =>
        Queue.offer(receipts, receipt).pipe(Effect.asVoid),
      streamEventsForTest: Stream.empty,
    }),
  );

  // Built into the test's scope: the worker fiber has to outlive the call that
  // acquires the service.
  const context = yield* Layer.build(layer.pipe(Layer.provide(dependencies)));
  const reactor = yield* Effect.service(FirstMateRequestDecisionReactor).pipe(
    Effect.provide(context),
  );
  yield* reactor.start();

  return {
    commands,
    emit: (event: OrchestrationEvent) => Queue.offer(events, event),
    /** Stands in for the projector between two passes of the same test. */
    setProject: (next: OrchestrationProjectShell) => Ref.set(project, next),
    /** Resolves once the reactor has finished one thread's pass. */
    nextReceipt: Queue.take(receipts),
  };
});

function supervisorLinked(threadId: ThreadId | null): OrchestrationEvent {
  return {
    sequence: 2,
    eventId: EventId.make(`evt-supervisor-${threadId ?? "none"}`),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "firstmate.domain-event",
    payload: {
      type: "firstmate.supervisor-linked",
      projectId: PROJECT_ID,
      threadId,
      occurredAt: NOW,
    },
  } as OrchestrationEvent;
}

describe("FirstMate request decision backfill scan", () => {
  const blocked = makeThread(WORKER_THREAD_ID);
  const quiet = makeThread(OTHER_THREAD_ID, { hasPendingApprovals: false });
  const supervisor = makeThread(SUPERVISOR_THREAD_ID);

  it("reads only the threads the shell already says are blocked", () => {
    const threadIds = firstMateBackfillThreadIds(
      {
        projects: [makeProject({ topics: [], decisions: [] })],
        threads: [quiet, blocked, supervisor],
      },
      null,
    );
    // The quiet thread never has its detail read, which is what keeps a
    // project of hundreds of settled threads cheap to scan.
    expect(threadIds).toEqual([WORKER_THREAD_ID]);
  });

  it("counts a thread waiting on user input, not only on approval", () => {
    const awaitingInput = makeThread(OTHER_THREAD_ID, {
      hasPendingApprovals: false,
      hasPendingUserInput: true,
    });
    expect(
      firstMateBackfillThreadIds(
        { projects: [makeProject({ topics: [], decisions: [] })], threads: [awaitingInput] },
        null,
      ),
    ).toEqual([OTHER_THREAD_ID]);
  });

  it("scans nothing for a project with no FirstMate workspace", () => {
    expect(
      firstMateBackfillThreadIds(
        {
          projects: [makeProject({ topics: [], decisions: [], withWorkspace: false })],
          threads: [blocked],
        },
        null,
      ),
    ).toEqual([]);
  });

  it("narrows to one project when a single project starts being supervised", () => {
    expect(
      firstMateBackfillThreadIds(
        { projects: [makeProject({ topics: [], decisions: [] })], threads: [blocked] },
        ProjectId.make("project-other"),
      ),
    ).toEqual([]);
  });
});

describe("FirstMate request decisions on start and on switching FirstMate on", () => {
  it.effect("raises cards for threads already blocked when the server starts", () =>
    Effect.gen(function* () {
      // Nothing new happens: the request has been sitting on the thread since
      // before this process existed, which is what left the inbox empty.
      const harness = yield* makeHarness({
        project: makeProject({ topics: [], decisions: [] }),
        activities: { [WORKER_THREAD_ID]: [approvalRequested(REQUEST_ID)] },
        shellThreads: [makeThread(WORKER_THREAD_ID), makeThread(SUPERVISOR_THREAD_ID)],
      });

      expect(yield* harness.nextReceipt).toMatchObject({
        type: "firstmate.request-decision.settled",
        threadId: WORKER_THREAD_ID,
        outcome: "reconciled",
        openedCount: 1,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "firstmate.decision.open",
          decisionId: EXPECTED_DECISION_ID,
          topicId: null,
          blocking: true,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("scans the project when a supervisor is linked, and never twice over", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({ topics: [], decisions: [] }),
        activities: { [WORKER_THREAD_ID]: [approvalRequested(REQUEST_ID)] },
        shellThreads: [makeThread(WORKER_THREAD_ID)],
      });

      expect(yield* harness.nextReceipt).toMatchObject({
        threadId: WORKER_THREAD_ID,
        openedCount: 1,
      });

      // The workspace as the projector leaves it once the first scan lands.
      yield* harness.setProject(
        makeProject({ topics: [], decisions: [openRequestDecision({ topicId: null })] }),
      );
      yield* harness.emit(supervisorLinked(SUPERVISOR_THREAD_ID));

      // Same thread, same request, same derived id: the second scan finds the
      // card already there and opens nothing.
      expect(yield* harness.nextReceipt).toMatchObject({
        threadId: WORKER_THREAD_ID,
        outcome: "reconciled",
        openedCount: 0,
        cancelledCount: 0,
      });
      expect(yield* Ref.get(harness.commands)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not scan a project when its supervisor is unlinked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({ topics: [], decisions: [] }),
        activities: { [WORKER_THREAD_ID]: [approvalRequested(REQUEST_ID)] },
        shellThreads: [makeThread(WORKER_THREAD_ID)],
      });

      expect(yield* harness.nextReceipt).toMatchObject({ openedCount: 1 });
      yield* harness.emit(supervisorLinked(null));
      // A delegation behind it proves the unlink produced no pass of its own:
      // this receipt is the delegation's, not a scan's.
      yield* harness.emit(topicDelegated(OTHER_THREAD_ID));
      expect(yield* harness.nextReceipt).toMatchObject({ threadId: OTHER_THREAD_ID });
    }).pipe(Effect.scoped),
  );
});

describe("FirstMate request decisions on delegation", () => {
  it.effect("raises a card for a request that was already waiting when the topic arrived", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({ topics: [makeTopic()], decisions: [] }),
        activities: { [WORKER_THREAD_ID]: [approvalRequested(REQUEST_ID)] },
      });

      yield* harness.emit(topicDelegated(WORKER_THREAD_ID));
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "firstmate.request-decision.settled",
        threadId: WORKER_THREAD_ID,
        outcome: "reconciled",
        openedCount: 1,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "firstmate.decision.open",
          decisionId: EXPECTED_DECISION_ID,
          topicId: TOPIC_ID,
          blocking: true,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("moving a topic to another thread does not disturb the old thread's card", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        // The workspace as the projector left it: the topic now points at the
        // new thread, and the old thread's card is still pending.
        project: makeProject({
          topics: [makeTopic({ threadId: OTHER_THREAD_ID })],
          decisions: [openRequestDecision()],
        }),
        activities: { [WORKER_THREAD_ID]: [approvalRequested(REQUEST_ID)] },
      });

      yield* harness.emit(topicDelegated(OTHER_THREAD_ID));
      // Only the thread the event names is re-checked now. The old thread's
      // request is still open, and its card is still the user's to answer.
      expect(yield* harness.nextReceipt).toMatchObject({
        threadId: OTHER_THREAD_ID,
        outcome: "reconciled",
        openedCount: 0,
        cancelledCount: 0,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("delegating a thread with nothing pending changes nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({ topics: [makeTopic()], decisions: [] }),
      });

      yield* harness.emit(topicDelegated(WORKER_THREAD_ID));
      expect(yield* harness.nextReceipt).toMatchObject({
        threadId: WORKER_THREAD_ID,
        outcome: "reconciled",
        openedCount: 0,
        cancelledCount: 0,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
