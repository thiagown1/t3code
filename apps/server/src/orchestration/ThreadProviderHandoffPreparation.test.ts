import type {
  FirstMateDecision,
  OrchestrationProjectShell,
  OrchestrationThread,
  ProjectId,
  ThreadId,
  ThreadProviderHandoffProvider,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  prepareThreadProviderHandoff,
  ThreadProviderHandoffPreparationError,
  type ThreadProviderHandoffPreparationSnapshot,
} from "./ThreadProviderHandoffPreparation.ts";

const NOW = "2026-09-16T12:00:00.000Z";
const THREAD_ID = "thread-source" as ThreadId;
const PROJECT_ID = "project-source" as ProjectId;
const TURN_ID = "turn-source" as TurnId;
const SOURCE = {
  providerInstanceId: "codex-primary",
  driver: "codex",
  model: "gpt-5.4",
} as unknown as ThreadProviderHandoffProvider;
const TARGET = {
  providerInstanceId: "claude-primary",
  driver: "claudeAgent",
  model: "claude-opus-4-6",
} as unknown as ThreadProviderHandoffProvider;

function project(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "workspace",
    defaultModelSelection: null,
    scripts: [],
    firstMate: {
      projectId: PROJECT_ID,
      supervisorThreadId: null,
      selectedTopicId: null,
      topics: [
        {
          id: "topic-source",
          projectId: PROJECT_ID,
          title: "Source topic",
          summary: "Source topic",
          stage: "completed",
          threadId: THREAD_ID,
          responsibleAgentId: null,
          createdAt: NOW,
          updatedAt: NOW,
          completedAt: NOW,
        },
      ],
      decisions: [resolvedDecision()],
      routingReceipts: [],
      routingEvaluationMode: "off",
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as OrchestrationProjectShell;
}

function resolvedDecision(): FirstMateDecision {
  return {
    id: "decision-source",
    projectId: PROJECT_ID,
    topicId: "topic-source",
    source: { kind: "firstmate", sourceId: "private-source" },
    question: "Continue?",
    options: [{ id: "yes", label: "Yes", description: "Continue" }],
    recommendedOptionId: "yes",
    selectedOptionId: "yes",
    blocking: true,
    status: "resolved",
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: NOW,
  } as unknown as FirstMateDecision;
}

function thread(): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Source thread",
    modelSelection: { instanceId: "codex-primary", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/handoff",
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId: TURN_ID,
      state: "completed",
      requestedAt: "2026-09-16T11:58:00.000Z",
      startedAt: "2026-09-16T11:58:01.000Z",
      completedAt: "2026-09-16T11:59:00.000Z",
      assistantMessageId: "message-assistant",
    },
    createdAt: "2026-09-16T11:57:00.000Z",
    updatedAt: "2026-09-16T11:59:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: "message-user",
        role: "user",
        text: "Prepare the handoff",
        attachments: [
          {
            id: "attachment-one",
            type: "text",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            content: "not portable",
          },
        ],
        turnId: TURN_ID,
        streaming: false,
        createdAt: "2026-09-16T11:58:00.000Z",
        updatedAt: "2026-09-16T11:58:00.000Z",
      },
      {
        id: "message-assistant",
        role: "assistant",
        text: "Ready",
        turnId: TURN_ID,
        streaming: false,
        createdAt: "2026-09-16T11:59:00.000Z",
        updatedAt: "2026-09-16T11:59:00.000Z",
      },
    ],
    proposedPlans: [
      {
        id: "plan-source",
        turnId: TURN_ID,
        planMarkdown: "1. Prepare\n2. Verify",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    activities: [],
    checkpoints: [],
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: "codex",
      providerInstanceId: "codex-primary",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
  } as unknown as OrchestrationThread;
}

function snapshot(
  overrides: Partial<ThreadProviderHandoffPreparationSnapshot> = {},
): ThreadProviderHandoffPreparationSnapshot {
  return {
    snapshotSequence: 23,
    thread: thread(),
    project: project(),
    decisions: [resolvedDecision()],
    pendingTurnStart: null,
    availableTargets: [TARGET],
    availableTargetsAttestation: { version: 1, snapshotSequence: 23 },
    ...overrides,
  };
}

function prepare(
  state = snapshot(),
  overrides: Partial<Parameters<typeof prepareThreadProviderHandoff>[0]> = {},
) {
  return prepareThreadProviderHandoff(
    {
      handoffId: "handoff-23",
      threadId: THREAD_ID,
      source: SOURCE,
      target: TARGET,
      reason: "quota",
      expectedSequence: 23,
      expectedTurnId: TURN_ID,
      createdAt: NOW,
      ...overrides,
    },
    state,
  );
}

function expectBlocked(
  code: ThreadProviderHandoffPreparationError["code"],
  action: () => unknown,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ThreadProviderHandoffPreparationError);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toMatch(/private-source|workspace|not portable/);
    return;
  }
  throw new Error(`Expected preparation to fail with ${code}`);
}

describe("prepareThreadProviderHandoff", () => {
  it("prepares a sanitized envelope from the exact persisted snapshot", () => {
    const envelope = prepare();

    expect(envelope).toMatchObject({
      handoffId: "handoff-23",
      threadId: THREAD_ID,
      source: SOURCE,
      target: TARGET,
      reason: "quota",
      sequence: 23,
      sourceTurnId: TURN_ID,
      context: {
        projectId: PROJECT_ID,
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: "feature/handoff",
      },
    });
    expect(envelope.context.messages.map((message) => message.sourceMessageId)).toEqual([
      "message-user",
      "message-assistant",
    ]);
    expect(envelope.context.proposedPlans).toHaveLength(1);
    expect(envelope.context.resolvedDecisions).toEqual([
      { sourceDecisionId: "decision-source", selectedOptionId: "yes", resolvedAt: NOW },
    ]);
    expect(envelope.omissions).toEqual(
      expect.arrayContaining([
        { kind: "approval", count: 1 },
        { kind: "attachment-content", count: 1 },
        { kind: "question", count: 1 },
      ]),
    );
    expect(JSON.stringify(envelope)).not.toMatch(/private-source|not portable|workspaceRoot/);
  });

  it("rejects a stale projection sequence", () => {
    expectBlocked("stale-sequence", () => prepare(snapshot(), { expectedSequence: 22 }));
  });

  it("rejects stale turn and context hash expectations", () => {
    expectBlocked("stale-turn", () =>
      prepare(snapshot(), { expectedTurnId: "older-turn" as TurnId }),
    );
    const contextHash = prepare().contextHash;
    expectBlocked("stale-context", () =>
      prepare(snapshot(), { expectedContextHash: contextHash.replace(/^./, "0") }),
    );
  });

  it("rejects thread, project, decision, and source mismatches", () => {
    expectBlocked("thread-mismatch", () =>
      prepare(snapshot(), { threadId: "different-thread" as ThreadId }),
    );
    expectBlocked("project-mismatch", () =>
      prepare(snapshot({ project: { ...project(), id: "different-project" as ProjectId } })),
    );
    expectBlocked("decision-mismatch", () =>
      prepare(
        snapshot({
          decisions: [
            { ...resolvedDecision(), topicId: "different-topic" } as unknown as FirstMateDecision,
          ],
        }),
      ),
    );
    expectBlocked("source-mismatch", () =>
      prepare(
        snapshot({
          thread: {
            ...thread(),
            modelSelection: {
              ...thread().modelSelection,
              model: "different-model",
            },
          },
        }),
      ),
    );
  });

  it("rejects an invalid target without changing the persisted source", () => {
    const state = snapshot();
    const sourceBefore = structuredClone(state.thread.modelSelection);
    expectBlocked("target-invalid", () => prepare(state, { target: SOURCE }));
    expectBlocked("target-invalid", () =>
      prepare(state, {
        target: {
          providerInstanceId: "missing-provider",
          driver: "claudeAgent",
          model: "claude-opus-4-6",
        } as unknown as ThreadProviderHandoffProvider,
      }),
    );
    expect(state.thread.modelSelection).toEqual(sourceBefore);
  });

  it("rejects target availability from a different persisted sequence", () => {
    expectBlocked("target-invalid", () =>
      prepare(
        snapshot({
          availableTargetsAttestation: { version: 1, snapshotSequence: 22 },
        }),
      ),
    );
  });

  it("blocks streaming messages", () => {
    const current = thread();
    expectBlocked("streaming", () =>
      prepare(
        snapshot({
          thread: {
            ...current,
            messages: current.messages.map((message, index) =>
              index === 1 ? { ...message, streaming: true } : message,
            ),
          },
        }),
      ),
    );
  });

  it.each([
    ["approval.requested", "pending-approval"],
    ["user-input.requested", "pending-question"],
  ] as const)("blocks %s activities", (kind, code) => {
    expectBlocked(code, () =>
      prepare(
        snapshot({
          thread: {
            ...thread(),
            activities: [
              {
                id: `activity-${kind}` as never,
                tone: "approval",
                kind,
                summary: "Pending",
                payload: { requestId: "request-one" },
                turnId: TURN_ID,
                createdAt: NOW,
              },
            ],
          },
        }),
      ),
    );
  });

  it.each(["approval.requested", "user-input.requested"] as const)(
    "blocks malformed %s activities without a request id",
    (kind) => {
      expectBlocked(kind === "approval.requested" ? "pending-approval" : "pending-question", () =>
        prepare(
          snapshot({
            thread: {
              ...thread(),
              activities: [
                {
                  id: `activity-${kind}` as never,
                  tone: "approval",
                  kind,
                  summary: "Pending",
                  payload: {},
                  turnId: TURN_ID,
                  createdAt: NOW,
                },
              ],
            },
          }),
        ),
      );
    },
  );

  it("blocks a pending FirstMate decision", () => {
    const pending = {
      ...resolvedDecision(),
      status: "pending" as const,
      selectedOptionId: null,
      resolvedAt: null,
    };
    expectBlocked("pending-question", () =>
      prepare(
        snapshot({
          project: {
            ...project(),
            firstMate: { ...project().firstMate!, decisions: [pending] },
          },
          decisions: [pending],
        }),
      ),
    );
  });

  it("rejects an omitted authoritative FirstMate decision", () => {
    expectBlocked("decision-mismatch", () => prepare(snapshot({ decisions: [] })));
  });

  it("blocks a persisted pending turn even when its message is older than the latest turn", () => {
    expectBlocked("queued-after-current-turn", () =>
      prepare(
        snapshot({
          pendingTurnStart: {
            threadId: THREAD_ID,
            messageId: "message-user" as never,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            requestedAt: "2026-09-16T10:00:00.000Z",
          },
        }),
      ),
    );
  });

  it("accepts the completed turn's real user message without a projected turn ID", () => {
    const current = thread();
    expect(
      prepare(
        snapshot({
          thread: {
            ...current,
            messages: current.messages.map((message) =>
              message.role === "user" ? { ...message, turnId: null } : message,
            ),
          },
        }),
      ).threadId,
    ).toBe(THREAD_ID);
  });

  it("blocks a running projected turn even if its provider session looks ready", () => {
    expectBlocked("session-active", () =>
      prepare(
        snapshot({
          thread: {
            ...thread(),
            latestTurn: { ...thread().latestTurn!, state: "running" },
          },
        }),
      ),
    );
  });

  it.each(["starting", "running"] as const)("blocks a %s provider session", (status) => {
    expectBlocked("session-active", () =>
      prepare(snapshot({ thread: { ...thread(), session: { ...thread().session!, status } } })),
    );
  });

  it("blocks an unknown provider session", () => {
    expectBlocked("session-unknown", () =>
      prepare(snapshot({ thread: { ...thread(), session: null } })),
    );
    expectBlocked("session-unknown", () =>
      prepare(
        snapshot({
          thread: {
            ...thread(),
            session: { ...thread().session!, status: "unknown" } as never,
          },
        }),
      ),
    );
  });

  it.each([
    ["/compact", "compaction-active"],
    ["continue after this turn", "queued-after-current-turn"],
  ] as const)("blocks pending work: %s", (text, code) => {
    const current = thread();
    expectBlocked(code, () =>
      prepare(
        snapshot({
          thread: {
            ...current,
            messages: [
              ...current.messages,
              {
                id: "message-queued" as never,
                role: "user",
                text,
                turnId: null,
                streaming: false,
                createdAt: "2026-09-16T11:59:30.000Z",
                updatedAt: "2026-09-16T11:59:30.000Z",
              },
            ],
          },
        }),
      ),
    );
  });

  it.each([null, TURN_ID] as const)(
    "blocks durable queued work independently of age or stale turn attribution (%s)",
    (turnId) => {
      const current = thread();
      expectBlocked("queued-after-current-turn", () =>
        prepare(
          snapshot({
            thread: {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: "message-old-queued" as never,
                  role: "user",
                  text: "continue later",
                  turnId,
                  streaming: false,
                  createdAt: "2026-09-16T11:59:30.000Z",
                  updatedAt: "2026-09-16T11:59:30.000Z",
                },
              ],
            },
          }),
          { createdAt: "2026-09-16T15:00:00.000Z" },
        ),
      );
    },
  );
});
