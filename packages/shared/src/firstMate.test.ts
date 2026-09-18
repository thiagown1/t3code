import {
  CommandId,
  FirstMateDecisionId,
  FirstMateTopicId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type FirstMateCommand,
  type FirstMateTopic,
  type FirstMateTopicRuntimeFacts,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createEmptyFirstMateWorkspace,
  decideFirstMateCommand,
  deriveFirstMateTopicReadModel,
  deriveFirstMateTopicStatus,
  evaluateFirstMateAutomaticRouting,
  firstMateTopicMention,
  replayFirstMateEvents,
  routeFirstMateMessage,
} from "./firstMate.ts";

const projectId = ProjectId.make("project-1");
const topicId = FirstMateTopicId.make("topic-1");
const secondTopicId = FirstMateTopicId.make("topic-2");
const decisionId = FirstMateDecisionId.make("decision-1");

type WithoutCommandBase<Value> = Value extends FirstMateCommand
  ? Omit<Value, "commandId" | "projectId" | "createdAt"> & { readonly createdAt?: string }
  : never;

function command(value: WithoutCommandBase<FirstMateCommand>): FirstMateCommand {
  return {
    ...value,
    commandId: CommandId.make(`command-${value.type}`),
    projectId,
    createdAt: value.createdAt ?? "2026-09-14T20:00:00.000Z",
  } as FirstMateCommand;
}

function accept(state: ReturnType<typeof createEmptyFirstMateWorkspace>, value: FirstMateCommand) {
  const result = decideFirstMateCommand(state, value);
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  return replayFirstMateEvents(state, result.events);
}

function topicCreate(): FirstMateCommand {
  return command({
    type: "firstmate.topic.create",
    topicId,
    title: "Machine monitoring",
    summary: "Show capacity across connected environments.",
    stage: "implementation",
    threadId: ThreadId.make("thread-1"),
    responsibleAgentId: "agent-1",
  });
}

describe("FirstMate domain", () => {
  it("creates and updates one topic in place during replay", () => {
    let state = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    state = accept(state, topicCreate());
    state = accept(
      state,
      command({
        type: "firstmate.topic.update",
        topicId,
        summary: "Monitoring implementation is ready for validation.",
        stage: "completed",
        createdAt: "2026-09-14T21:00:00.000Z",
      }),
    );

    expect(state.topics).toHaveLength(1);
    expect(state.topics[0]).toMatchObject({
      id: topicId,
      summary: "Monitoring implementation is ready for validation.",
      stage: "completed",
      completedAt: "2026-09-14T21:00:00.000Z",
    });
  });

  it("rejects duplicate topics and commands for missing topics", () => {
    const empty = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    const state = accept(empty, topicCreate());

    expect(decideFirstMateCommand(state, topicCreate())).toEqual({
      accepted: false,
      reason: "topic-already-exists",
    });
    expect(
      decideFirstMateCommand(
        empty,
        command({
          type: "firstmate.topic.delegate",
          topicId,
          threadId: null,
          responsibleAgentId: null,
        }),
      ),
    ).toEqual({ accepted: false, reason: "topic-not-found" });
  });

  it("persists the selected topic and rejects an unknown selection", () => {
    const empty = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    let state = accept(empty, topicCreate());
    state = accept(
      state,
      command({
        type: "firstmate.topic.select",
        topicId,
      }),
    );

    expect(state.selectedTopicId).toBe(topicId);
    expect(
      decideFirstMateCommand(
        state,
        command({
          type: "firstmate.topic.select",
          topicId: secondTopicId,
        }),
      ),
    ).toEqual({ accepted: false, reason: "topic-not-found" });
  });

  it("keeps a decision pinned until it is explicitly resolved", () => {
    let state = accept(
      createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z"),
      topicCreate(),
    );
    state = accept(
      state,
      command({
        type: "firstmate.decision.open",
        decisionId,
        topicId,
        source: { kind: "firstmate", sourceId: "routing-choice" },
        question: "Deploy behind a feature flag?",
        options: [
          { id: "yes", label: "Yes", description: "Keep activation separate." },
          { id: "no", label: "No", description: "Release directly." },
        ],
        recommendedOptionId: "yes",
        blocking: true,
      }),
    );

    expect(state.decisions[0]?.status).toBe("pending");
    state = accept(
      state,
      command({
        type: "firstmate.decision.resolve",
        decisionId,
        selectedOptionId: "yes",
        createdAt: "2026-09-14T22:00:00.000Z",
      }),
    );
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      status: "resolved",
      selectedOptionId: "yes",
      resolvedAt: "2026-09-14T22:00:00.000Z",
    });
  });

  it("rejects a resolution that is not one of the persisted options", () => {
    let state = accept(
      createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z"),
      topicCreate(),
    );
    state = accept(
      state,
      command({
        type: "firstmate.decision.open",
        decisionId,
        topicId,
        source: { kind: "firstmate", sourceId: "routing-choice" },
        question: "Deploy behind a feature flag?",
        options: [{ id: "yes", label: "Yes", description: "Keep activation separate." }],
        recommendedOptionId: "yes",
        blocking: true,
      }),
    );

    expect(
      decideFirstMateCommand(
        state,
        command({
          type: "firstmate.decision.resolve",
          decisionId,
          selectedOptionId: "unknown",
        }),
      ),
    ).toEqual({ accepted: false, reason: "decision-option-not-found" });
  });

  it("records one round summary per turn without touching the authored summary", () => {
    let state = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    state = accept(state, topicCreate());

    const record = (turn: string, text: string, createdAt: string): FirstMateCommand =>
      command({
        type: "firstmate.topic.record-round-summary",
        topicId,
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make(turn),
        text,
        createdAt,
      });

    state = accept(
      state,
      record("turn-1", "Added the capacity probe; no tests run.", "2026-09-14T21:00:00.000Z"),
    );
    const topic = state.topics[0]!;
    expect(topic.latestRoundSummary).toEqual({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      text: "Added the capacity probe; no tests run.",
      generatedAt: "2026-09-14T21:00:00.000Z",
    });
    // The authored description is what the topic must achieve and is never
    // overwritten by what a round happened to produce.
    expect(topic.summary).toBe("Show capacity across connected environments.");
    expect(topic.updatedAt).toBe("2026-09-14T21:00:00.000Z");

    expect(
      decideFirstMateCommand(
        state,
        record("turn-1", "Re-summarized the same round.", "2026-09-14T22:00:00.000Z"),
      ),
    ).toEqual({ accepted: false, reason: "round-summary-already-recorded" });

    state = accept(
      state,
      record("turn-2", "Probe still fails on Windows.", "2026-09-14T22:00:00.000Z"),
    );
    expect(state.topics[0]?.latestRoundSummary?.text).toBe("Probe still fails on Windows.");
  });

  it("rejects a summary for a thread the topic no longer owns", () => {
    let state = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    state = accept(state, topicCreate());
    state = accept(
      state,
      command({
        type: "firstmate.topic.delegate",
        topicId,
        threadId: ThreadId.make("thread-2"),
        responsibleAgentId: "agent-1",
      }),
    );

    expect(
      decideFirstMateCommand(
        state,
        command({
          type: "firstmate.topic.record-round-summary",
          topicId,
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          text: "Stale round from the previous thread.",
        }),
      ),
    ).toEqual({ accepted: false, reason: "round-summary-thread-mismatch" });
  });
});

describe("FirstMate deterministic routing", () => {
  function routingWorkspace() {
    let state = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    state = accept(state, topicCreate());
    state = accept(
      state,
      command({
        type: "firstmate.topic.create",
        topicId: secondTopicId,
        title: "CI checks",
        summary: "Keep checks current.",
        stage: "implementation",
        threadId: ThreadId.make("thread-2"),
        responsibleAgentId: "agent-2",
      }),
    );
    return accept(
      state,
      command({
        type: "firstmate.topic.select",
        topicId,
      }),
    );
  }

  it("routes to the selected topic by default", () => {
    expect(routeFirstMateMessage(routingWorkspace(), "Continue the implementation.")).toEqual({
      status: "routed",
      reason: "selected-topic",
      topicId,
      threadId: ThreadId.make("thread-1"),
      message: "Continue the implementation.",
    });
  });

  it("lets one exact topic mention override the selected topic", () => {
    const message = `${firstMateTopicMention(secondTopicId)} Re-run the current checks.`;

    expect(routeFirstMateMessage(routingWorkspace(), message)).toEqual({
      status: "routed",
      reason: "explicit-mention",
      topicId: secondTopicId,
      threadId: ThreadId.make("thread-2"),
      message,
    });
  });

  it("fails closed when the destination is missing, ambiguous, or not delegated", () => {
    const state = routingWorkspace();
    const withoutSelection = { ...state, selectedTopicId: null };
    expect(routeFirstMateMessage(withoutSelection, "Continue.")).toMatchObject({
      status: "needs-confirmation",
      reason: "no-selected-topic",
      candidateTopicIds: [topicId, secondTopicId],
    });

    expect(
      routeFirstMateMessage(
        state,
        `${firstMateTopicMention(topicId)} ${firstMateTopicMention(secondTopicId)} Continue.`,
      ),
    ).toMatchObject({
      status: "needs-confirmation",
      reason: "multiple-topic-mentions",
      candidateTopicIds: [topicId, secondTopicId],
    });

    expect(
      routeFirstMateMessage(
        state,
        `${firstMateTopicMention(FirstMateTopicId.make("missing"))} Continue.`,
      ),
    ).toEqual({
      status: "needs-confirmation",
      reason: "mentioned-topic-not-found",
      candidateTopicIds: [],
    });

    const undelegated = {
      ...state,
      topics: state.topics.map((topic) =>
        topic.id === topicId ? { ...topic, threadId: null } : topic,
      ),
    };
    expect(routeFirstMateMessage(undelegated, "Continue.")).toEqual({
      status: "needs-confirmation",
      reason: "topic-not-delegated",
      candidateTopicIds: [topicId],
    });

    const recursive = {
      ...state,
      supervisorThreadId: ThreadId.make("thread-1"),
    };
    expect(routeFirstMateMessage(recursive, "Continue.")).toEqual({
      status: "needs-confirmation",
      reason: "topic-is-supervisor",
      candidateTopicIds: [topicId],
    });
  });
});

describe("FirstMate routing audit", () => {
  function routingWorkspace() {
    let state = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    state = accept(
      state,
      command({
        type: "firstmate.supervisor.link",
        threadId: ThreadId.make("thread-supervisor"),
      }),
    );
    return accept(state, topicCreate());
  }

  it("records why a supervisor message was routed without storing its body", () => {
    const state = routingWorkspace();
    const recorded = accept(
      state,
      command({
        type: "firstmate.routing.record",
        messageId: MessageId.make("message-1"),
        sourceThreadId: ThreadId.make("thread-supervisor"),
        topicId,
        destinationThreadId: ThreadId.make("thread-1"),
        reason: "selected-topic",
        evaluation: null,
      }),
    );

    expect(recorded.routingReceipts).toEqual([
      {
        messageId: "message-1",
        projectId: "project-1",
        sourceThreadId: "thread-supervisor",
        topicId: "topic-1",
        destinationThreadId: "thread-1",
        reason: "selected-topic",
        evaluation: null,
        routedAt: "2026-09-14T20:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(recorded.routingReceipts)).not.toContain("Continue");
  });

  it("rejects receipts that do not match the supervisor or delegated worker", () => {
    const state = routingWorkspace();
    const base = {
      type: "firstmate.routing.record" as const,
      messageId: MessageId.make("message-1"),
      sourceThreadId: ThreadId.make("wrong-supervisor"),
      topicId,
      destinationThreadId: ThreadId.make("thread-1"),
      reason: "explicit-mention" as const,
      evaluation: null,
    };

    expect(decideFirstMateCommand(state, command(base))).toEqual({
      accepted: false,
      reason: "routing-source-not-supervisor",
    });
    expect(
      decideFirstMateCommand(
        state,
        command({
          ...base,
          sourceThreadId: ThreadId.make("thread-supervisor"),
          destinationThreadId: ThreadId.make("wrong-worker"),
        }),
      ),
    ).toEqual({ accepted: false, reason: "routing-destination-mismatch" });
  });

  it("keeps only the latest routing receipts in the workspace snapshot", () => {
    let state = routingWorkspace();
    for (let index = 0; index < 51; index += 1) {
      state = accept(
        state,
        command({
          type: "firstmate.routing.record",
          messageId: MessageId.make(`message-${index}`),
          sourceThreadId: ThreadId.make("thread-supervisor"),
          topicId,
          destinationThreadId: ThreadId.make("thread-1"),
          reason: "selected-topic",
          evaluation: null,
          createdAt: `2026-09-14T20:00:${String(index).padStart(2, "0")}.000Z`,
        }),
      );
    }

    expect(state.routingReceipts).toHaveLength(50);
    expect(state.routingReceipts[0]?.messageId).toBe("message-1");
    expect(state.routingReceipts[49]?.messageId).toBe("message-50");
  });
});

describe("FirstMate automatic routing evaluation", () => {
  function evaluationWorkspace() {
    let state = createEmptyFirstMateWorkspace(projectId, "2026-09-14T19:00:00.000Z");
    state = accept(state, topicCreate());
    state = accept(
      state,
      command({
        type: "firstmate.topic.create",
        topicId: secondTopicId,
        title: "CI checks",
        summary: "Re-run GitHub validation and inspect failures.",
        stage: "testing",
        threadId: ThreadId.make("thread-2"),
        responsibleAgentId: "agent-2",
      }),
    );
    return state;
  }

  it("is off by default and never changes the authoritative destination", () => {
    const state = evaluationWorkspace();
    expect(
      evaluateFirstMateAutomaticRouting(state, "Please re-run the CI checks.", secondTopicId),
    ).toBeNull();
  });

  it("records a shadow suggestion as agreement or disagreement", () => {
    const selected = accept(
      evaluationWorkspace(),
      command({ type: "firstmate.topic.select", topicId }),
    );
    const state = accept(
      selected,
      command({ type: "firstmate.routing-evaluation-mode.set", mode: "shadow" }),
    );
    const agreed = evaluateFirstMateAutomaticRouting(
      state,
      "Please re-run the CI checks and inspect failures.",
      secondTopicId,
    );
    const disagreed = evaluateFirstMateAutomaticRouting(
      state,
      "Please re-run the CI checks and inspect failures.",
      topicId,
    );

    expect(agreed).toMatchObject({
      candidateTopicId: secondTopicId,
      outcome: "matched",
    });
    expect(disagreed).toMatchObject({
      candidateTopicId: secondTopicId,
      outcome: "different",
    });
    expect(agreed?.score).toBeGreaterThan(0);
    expect(
      routeFirstMateMessage(state, "Please re-run the CI checks and inspect failures."),
    ).toMatchObject({
      status: "routed",
      topicId,
      reason: "selected-topic",
    });
  });

  it("abstains when no topic has a unique meaningful score", () => {
    const state = accept(
      evaluationWorkspace(),
      command({ type: "firstmate.routing-evaluation-mode.set", mode: "shadow" }),
    );

    expect(evaluateFirstMateAutomaticRouting(state, "Continue.", topicId)).toEqual({
      candidateTopicId: null,
      score: 0,
      outcome: "no-candidate",
    });
  });
});

const baseTopic: FirstMateTopic = {
  id: topicId,
  projectId,
  title: "Deploy monitoring",
  summary: "Validate the production release.",
  stage: "completed",
  threadId: ThreadId.make("thread-1"),
  responsibleAgentId: "agent-1",
  latestRoundSummary: null,
  createdAt: "2026-09-14T19:00:00.000Z",
  updatedAt: "2026-09-14T20:00:00.000Z",
  completedAt: "2026-09-14T20:00:00.000Z",
};

const baseFacts: FirstMateTopicRuntimeFacts = {
  sessionStatus: "ready",
  pendingUserInputCount: 0,
  pendingApprovalCount: 0,
  pendingFirstMateDecisionCount: 0,
  backgroundLiveness: null,
  deliveryStatus: null,
  machineAlerts: { informational: 0, attention: 1, critical: 0 },
};

describe("FirstMate topic read model", () => {
  it("derives delivery and user waits instead of persisting another status", () => {
    expect(
      deriveFirstMateTopicStatus(baseTopic, {
        ...baseFacts,
        deliveryStatus: "waiting-deploy",
      }),
    ).toBe("waiting-deploy");
    expect(
      deriveFirstMateTopicStatus(baseTopic, {
        ...baseFacts,
        deliveryStatus: "waiting-deploy",
        pendingUserInputCount: 1,
      }),
    ).toBe("waiting-user");
  });

  it("aggregates machine alerts without turning monitoring into remediation", () => {
    expect(deriveFirstMateTopicReadModel(baseTopic, baseFacts)).toMatchObject({
      operationalStatus: "completed",
      pendingDecisionCount: 0,
      machineAlerts: { informational: 0, attention: 1, critical: 0 },
    });
  });

  it("marks a failed or interrupted execution as blocked", () => {
    expect(
      deriveFirstMateTopicStatus(
        { ...baseTopic, stage: "testing", completedAt: null },
        { ...baseFacts, sessionStatus: "error" },
      ),
    ).toBe("blocked");
  });

  it("keeps background monitoring visible after the provider turn settles", () => {
    expect(
      deriveFirstMateTopicStatus(baseTopic, {
        ...baseFacts,
        backgroundLiveness: "monitoring",
      }),
    ).toBe("monitoring");
  });
});
