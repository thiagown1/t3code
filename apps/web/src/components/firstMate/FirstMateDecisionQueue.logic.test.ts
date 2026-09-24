import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type FirstMateDecision,
  type FirstMateTopic,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFirstMateDecisionQueue,
  completeFirstMateQueueItem,
  deferFirstMateQueueItem,
  EMPTY_FIRST_MATE_QUEUE_CURSOR,
  firstMateQueuePriority,
  pinFirstMateQueueItem,
  presentFirstMateQueue,
  type FirstMateQueueItem,
} from "./FirstMateDecisionQueue.logic";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const now = "2026-09-24T12:00:00.000Z";
const nowMs = Date.parse(now);

function at(minutesAgo: number): string {
  return new Date(nowMs - minutesAgo * 60_000).toISOString();
}

function topic(id: string, threadId: string | null): FirstMateTopic {
  return {
    id: FirstMateTopicId.make(id),
    projectId,
    title: `Topic ${id}`,
    summary: `Goal of ${id}`,
    stage: "implementation",
    threadId: threadId === null ? null : ThreadId.make(threadId),
    responsibleAgentId: null,
    latestRoundSummary:
      threadId === null
        ? null
        : {
            threadId: ThreadId.make(threadId),
            turnId: TurnId.make(`${threadId}-turn`),
            text: `Round summary of ${id}`,
            generatedAt: now,
          },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function session(threadId: string, status: "running" | "error" | "ready") {
  return {
    threadId: ThreadId.make(threadId),
    status,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: status === "error" ? "Provider crashed" : null,
    updatedAt: at(5),
  };
}

function decision(
  id: string,
  source: FirstMateDecision["source"],
  overrides: Partial<FirstMateDecision> = {},
): FirstMateDecision {
  return {
    id: FirstMateDecisionId.make(id),
    projectId,
    topicId: null,
    source,
    question: `Question ${id}`,
    options: [{ id: "answer-myself", label: "I'll answer", description: "Reply myself." }],
    recommendedOptionId: null,
    selectedOptionId: null,
    blocking: true,
    status: "pending",
    createdAt: at(10),
    updatedAt: at(10),
    resolvedAt: null,
    ...overrides,
  };
}

function pullRequest(
  number: number,
  checkStatus: "failure" | "action-required" | "success",
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "thiagown1/t3code",
    number,
    url: `https://github.com/thiagown1/t3code/pull/${number}`,
    source: "agent",
    linkedAt: now,
    stack: null,
    snapshot: {
      state: "open",
      title: `PR ${number}`,
      headBranch: `branch-${number}`,
      headSha: `sha${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: now,
      syncedAt: at(1),
      checksState: checkStatus === "success" ? "passing" : "failing",
      checks: [{ name: "CI", status: checkStatus, description: null, url: null }],
    },
  };
}

function project(
  topics: ReadonlyArray<FirstMateTopic>,
  decisions: ReadonlyArray<FirstMateDecision>,
): EnvironmentProject {
  return {
    environmentId,
    id: projectId,
    title: "T3 Code",
    workspaceRoot: "/tmp/t3code",
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    firstMate: {
      projectId,
      supervisorThreadId: null,
      selectedTopicId: null,
      topics,
      decisions,
      routingReceipts: [],
      routingEvaluationMode: "off",
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

const turnReview = (
  threadId: string,
  outcome: "needs_user" | "blocked" | "done",
  confidence = 0.9,
) =>
  ({
    kind: "turn-review",
    threadId: ThreadId.make(threadId),
    turnId: TurnId.make(`${threadId}-turn`),
    verdict: { outcome, outcomeConfidence: confidence, inScope: 0.5 },
  }) as const;

describe("firstMateQueuePriority", () => {
  it("ranks a paused agent over the judge, the judge by outcome and confidence, then PRs", () => {
    const ranked = [
      firstMateQueuePriority({ kind: "provider-request" }),
      firstMateQueuePriority({
        kind: "turn-review",
        verdict: { outcome: "blocked", outcomeConfidence: 0.5, inScope: 0 },
      }),
      firstMateQueuePriority({
        kind: "turn-review",
        verdict: { outcome: "needs_user", outcomeConfidence: 1, inScope: 0 },
      }),
      firstMateQueuePriority({
        kind: "turn-review",
        verdict: { outcome: "needs_user", outcomeConfidence: 0.2, inScope: 0 },
      }),
      firstMateQueuePriority({ kind: "supervisor-question", blocking: true }),
      firstMateQueuePriority({ kind: "failed-run" }),
      firstMateQueuePriority({ kind: "pull-request", pullRequestStatus: "failing" }),
      firstMateQueuePriority({ kind: "pull-request", pullRequestStatus: "action-required" }),
      firstMateQueuePriority({ kind: "supervisor-question", blocking: false }),
      firstMateQueuePriority({
        kind: "turn-review",
        verdict: { outcome: "done", outcomeConfidence: 0.6, inScope: 1 },
      }),
    ];
    expect(ranked).toEqual([100, 95, 90, 82, 70, 65, 60, 55, 40, 30]);
  });

  it("ranks a turn review stored before verdicts by its blocking flag", () => {
    expect(firstMateQueuePriority({ kind: "turn-review", blocking: true })).toBe(80);
    expect(firstMateQueuePriority({ kind: "turn-review", blocking: false })).toBe(30);
  });
});

describe("buildFirstMateDecisionQueue", () => {
  it("collects every kind of waiting work, ranked, with the context to decide", () => {
    const queue = buildFirstMateDecisionQueue({
      project: project(
        [topic("review", "t-review"), topic("ci", "t-ci"), topic("crash", "t-crash")],
        [
          decision("jev", turnReview("t-review", "needs_user"), {
            topicId: FirstMateTopicId.make("review"),
          }),
          decision("ask", { kind: "firstmate", sourceId: "s1" }, { blocking: false }),
          decision("resolved", turnReview("t-review", "blocked"), { status: "resolved" }),
        ],
      ),
      threads: [
        thread("t-review"),
        thread("t-ci", { pullRequests: [pullRequest(7, "failure"), pullRequest(8, "success")] }),
        thread("t-crash", { session: session("t-crash", "error") }),
      ],
      nowMs,
    });

    expect(queue.map((item) => [item.kind, item.priority])).toEqual([
      ["turn-review", 89],
      ["failed-run", 65],
      ["pull-request", 60],
    ]);
    expect(queue[0]).toMatchObject({
      threadId: "t-review",
      topicTitle: "Topic review",
      topicSummary: "Goal of review",
      latestRoundSummary: "Round summary of review",
      detail: "Question jev",
      canReply: true,
      decision: { decisionId: "jev", sourceKind: "turn-review" },
    });
    expect(queue[2]).toMatchObject({
      headline: "Checks failed on #7",
      pullRequests: [{ number: 7, status: "failing" }],
    });
  });

  it("leaves out a turn review and PR state while the thread already runs again", () => {
    const queue = buildFirstMateDecisionQueue({
      project: project([topic("a", "t-a")], [decision("jev", turnReview("t-a", "blocked"))]),
      threads: [
        thread("t-a", {
          session: session("t-a", "running"),
          pullRequests: [pullRequest(7, "action-required")],
        }),
      ],
      nowMs,
    });
    expect(queue).toEqual([]);
  });

  it("does not repeat a provider request that already has a card, and never offers a reply to it", () => {
    const card = decision("approve", {
      kind: "approval",
      requestId: "req-1" as never,
      threadId: ThreadId.make("t-a"),
    });
    const queue = buildFirstMateDecisionQueue({
      project: project([topic("a", "t-a")], [card]),
      threads: [thread("t-a", { hasPendingApprovals: true })],
      nowMs,
    });
    expect(queue.map((item) => [item.kind, item.canReply])).toEqual([["provider-request", false]]);
  });

  it("puts the newer of two equally urgent items first", () => {
    const queue = buildFirstMateDecisionQueue({
      project: project(
        [],
        [
          decision("old", { kind: "firstmate", sourceId: "s1" }, { updatedAt: at(30) }),
          decision("new", { kind: "firstmate", sourceId: "s2" }, { updatedAt: at(1) }),
        ],
      ),
      threads: [],
      nowMs,
    });
    // Neither names a topic or a live thread, so the inbox model drops both;
    // attach a thread to make them visible.
    expect(queue).toEqual([]);

    const visible = buildFirstMateDecisionQueue({
      project: project(
        [topic("a", "t-a")],
        [
          decision(
            "old",
            { kind: "firstmate", sourceId: "s1" },
            { updatedAt: at(30), topicId: FirstMateTopicId.make("a") },
          ),
          decision(
            "new",
            { kind: "firstmate", sourceId: "s2" },
            { updatedAt: at(1), topicId: FirstMateTopicId.make("a") },
          ),
        ],
      ),
      threads: [thread("t-a")],
      nowMs,
    });
    expect(visible.map((item) => item.decision?.decisionId)).toEqual(["new", "old"]);
  });
});

describe("reading the queue", () => {
  const item = (key: string, priority: number): FirstMateQueueItem => ({
    key,
    kind: "supervisor-question",
    priority,
    environmentId,
    projectId,
    threadId: null,
    threadTitle: null,
    topicTitle: null,
    topicSummary: null,
    latestRoundSummary: null,
    headline: key,
    detail: null,
    decision: null,
    verdict: null,
    pullRequests: [],
    canReply: false,
    updatedAt: now,
  });

  it("keeps the item being read in place while a more urgent one arrives behind it", () => {
    const first = item("b", 50);
    let cursor = pinFirstMateQueueItem(EMPTY_FIRST_MATE_QUEUE_CURSOR, first);

    const view = presentFirstMateQueue([item("urgent", 100), first, item("c", 10)], cursor);

    expect(view.current?.key).toBe("b");
    expect(view.currentGone).toBe(false);
    expect(view.upNext.map((entry) => entry.key)).toEqual(["urgent", "c"]);

    cursor = completeFirstMateQueueItem(cursor, "b");
    expect(
      presentFirstMateQueue([item("urgent", 100), first, item("c", 10)], cursor),
    ).toMatchObject({ current: { key: "urgent" }, upNext: [{ key: "c" }] });
  });

  it("keeps showing an item that was resolved elsewhere until the user moves on", () => {
    const cursor = pinFirstMateQueueItem(EMPTY_FIRST_MATE_QUEUE_CURSOR, item("gone", 50));
    const view = presentFirstMateQueue([item("next", 40)], cursor);
    expect(view).toMatchObject({ current: { key: "gone" }, currentGone: true });
    expect(view.upNext.map((entry) => entry.key)).toEqual(["next"]);
  });

  it("sends a deferred item to the back and hides a handled one", () => {
    const queue = [item("a", 90), item("b", 80), item("c", 70)];
    const deferred = deferFirstMateQueueItem(
      pinFirstMateQueueItem(EMPTY_FIRST_MATE_QUEUE_CURSOR, queue[0]!),
      "a",
    );
    expect(presentFirstMateQueue(queue, deferred).current?.key).toBe("b");
    expect(presentFirstMateQueue(queue, deferred).upNext.map((entry) => entry.key)).toEqual([
      "c",
      "a",
    ]);

    const handled = completeFirstMateQueueItem(deferred, "b");
    expect(presentFirstMateQueue(queue, handled).current?.key).toBe("c");
    expect(presentFirstMateQueue(queue, handled).upNext.map((entry) => entry.key)).toEqual(["a"]);
  });
});
