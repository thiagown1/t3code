import {
  ApprovalRequestId,
  EventId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftFirstMateRequestDecision,
  firstMateRequestDecisionId,
  firstMateRequestReply,
} from "./firstMateRequestDecisions.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-worker");
const REQUEST_ID = ApprovalRequestId.make("request-1");

function activity(input: {
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-1"),
    tone: "approval",
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    turnId: null,
    createdAt: NOW,
  } as OrchestrationThreadActivity;
}

function approvalRequest(
  options: ReadonlyArray<{ decision: string; label: string; warning?: string }>,
  detail = "rm -rf ./build",
): OrchestrationThreadActivity {
  return activity({
    kind: "approval.requested",
    summary: "Command approval requested",
    payload: { requestId: REQUEST_ID, requestKind: "command", detail, options },
  });
}

function userInputRequest(payload: unknown): OrchestrationThreadActivity {
  return activity({
    kind: "user-input.requested",
    summary: "User input requested",
    payload,
  });
}

const singleQuestionRequest = userInputRequest({
  requestId: REQUEST_ID,
  questions: [
    {
      id: "storage",
      header: "Storage",
      question: "Where should the cache live?",
      options: [
        { label: "In memory", description: "Fast, lost on restart." },
        { label: "On disk", description: "", value: "disk" },
      ],
    },
  ],
});

describe("firstMateRequestDecisionId", () => {
  it("is the same id for the same request", () => {
    expect(firstMateRequestDecisionId(THREAD_ID, REQUEST_ID)).toBe(
      firstMateRequestDecisionId(THREAD_ID, REQUEST_ID),
    );
  });

  it("separates the same request id raised on different threads", () => {
    expect(firstMateRequestDecisionId(THREAD_ID, REQUEST_ID)).not.toBe(
      firstMateRequestDecisionId(ThreadId.make("thread-other"), REQUEST_ID),
    );
  });
});

describe("drafting a card from an approval request", () => {
  it("uses each provider option's decision literal as the option id", () => {
    const draft = draftFirstMateRequestDecision({
      threadId: THREAD_ID,
      activity: approvalRequest([
        { decision: "accept", label: "Yes, run it" },
        { decision: "acceptForSession", label: "Yes, for this session" },
        { decision: "decline", label: "No" },
      ]),
    });
    expect(draft?.options.map((option) => option.id)).toEqual([
      "accept",
      "acceptForSession",
      "decline",
    ]);
    expect(draft?.source).toEqual({
      kind: "approval",
      requestId: REQUEST_ID,
      threadId: THREAD_ID,
    });
    expect(draft?.question).toBe("Command approval requested: rm -rf ./build");
  });

  it("says how far each choice reaches, since the provider label rarely does", () => {
    const draft = draftFirstMateRequestDecision({
      threadId: THREAD_ID,
      activity: approvalRequest([
        { decision: "accept", label: "Allow" },
        { decision: "acceptAlways", label: "Allow" },
      ]),
    });
    expect(draft?.options[0]?.description).toContain("once");
    expect(draft?.options[1]?.description).toContain("every time");
  });

  it("keeps a provider warning next to the option it warns about", () => {
    const draft = draftFirstMateRequestDecision({
      threadId: THREAD_ID,
      activity: approvalRequest([
        { decision: "accept", label: "Allow", warning: "Possible prompt injection." },
        { decision: "decline", label: "No" },
      ]),
    });
    expect(draft?.options[0]?.description).toContain("Possible prompt injection.");
  });

  it("refuses a request it cannot state exactly", () => {
    // No options: inventing accept/decline would put words in the provider's mouth.
    expect(
      draftFirstMateRequestDecision({
        threadId: THREAD_ID,
        activity: activity({
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: { requestId: REQUEST_ID, detail: "rm -rf ./build" },
        }),
      }),
    ).toBeNull();

    // One option is not a decision the user can make.
    expect(
      draftFirstMateRequestDecision({
        threadId: THREAD_ID,
        activity: approvalRequest([{ decision: "accept", label: "Allow" }]),
      }),
    ).toBeNull();

    // Not a request at all.
    expect(
      draftFirstMateRequestDecision({
        threadId: THREAD_ID,
        activity: activity({
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: { requestId: REQUEST_ID, decision: "accept" },
        }),
      }),
    ).toBeNull();
  });
});

describe("drafting a card from a user-input request", () => {
  it("offers one card option per answer, falling back to the label for a blank description", () => {
    const draft = draftFirstMateRequestDecision({
      threadId: THREAD_ID,
      activity: singleQuestionRequest,
    });
    expect(draft?.question).toBe("Where should the cache live?");
    expect(draft?.options).toEqual([
      { id: "answer:0", label: "In memory", description: "Fast, lost on restart." },
      { id: "answer:1", label: "On disk", description: "On disk" },
    ]);
  });

  it("refuses forms a single card cannot represent", () => {
    const refused = [
      // More than one question.
      {
        requestId: REQUEST_ID,
        questions: [
          {
            id: "a",
            header: "A",
            question: "First?",
            options: [
              { label: "Yes", description: "" },
              { label: "No", description: "" },
            ],
          },
          {
            id: "b",
            header: "B",
            question: "Second?",
            options: [
              { label: "Yes", description: "" },
              { label: "No", description: "" },
            ],
          },
        ],
      },
      // Multi-select: a card resolves to exactly one option.
      {
        requestId: REQUEST_ID,
        questions: [
          {
            id: "a",
            header: "A",
            question: "Which ones?",
            multiSelect: true,
            options: [
              { label: "Yes", description: "" },
              { label: "No", description: "" },
            ],
          },
        ],
      },
      // Free text only: nothing to choose between.
      {
        requestId: REQUEST_ID,
        questions: [{ id: "a", header: "A", question: "What name?", options: [] }],
      },
    ];
    for (const payload of refused) {
      expect(
        draftFirstMateRequestDecision({
          threadId: THREAD_ID,
          activity: userInputRequest(payload),
        }),
      ).toBeNull();
    }
  });
});

describe("reading a chosen option back as the provider's reply", () => {
  it("round-trips every approval option the card was built from", () => {
    const request = approvalRequest([
      { decision: "accept", label: "Yes, run it" },
      { decision: "acceptForSession", label: "Yes, for this session" },
      { decision: "decline", label: "No" },
    ]);
    const draft = draftFirstMateRequestDecision({ threadId: THREAD_ID, activity: request });
    for (const option of draft?.options ?? []) {
      expect(
        firstMateRequestReply({
          activity: request,
          selectedOptionId: option.id,
          optionLabel: option.label,
        }),
      ).toEqual({ kind: "approval", decision: option.id });
    }
  });

  it("round-trips a user-input answer into the record the provider expects", () => {
    const draft = draftFirstMateRequestDecision({
      threadId: THREAD_ID,
      activity: singleQuestionRequest,
    });
    expect(
      firstMateRequestReply({
        activity: singleQuestionRequest,
        selectedOptionId: "answer:0",
        optionLabel: draft!.options[0]!.label,
      }),
      // No `value`, so the label is the answer, exactly as every client sends it.
    ).toEqual({ kind: "user-input", answers: { storage: "In memory" } });
    expect(
      firstMateRequestReply({
        activity: singleQuestionRequest,
        selectedOptionId: "answer:1",
        optionLabel: draft!.options[1]!.label,
      }),
    ).toEqual({ kind: "user-input", answers: { storage: "disk" } });
  });

  it("refuses an option the live request does not offer", () => {
    const request = approvalRequest([
      { decision: "accept", label: "Yes, run it" },
      { decision: "decline", label: "No" },
    ]);
    // A real ProviderApprovalDecision, but not one this request offered.
    expect(
      firstMateRequestReply({
        activity: request,
        selectedOptionId: "acceptAlways",
        optionLabel: "Yes, run it",
      }),
    ).toBeNull();
    // Free text that is not a provider literal at all.
    expect(
      firstMateRequestReply({
        activity: request,
        selectedOptionId: "sure-why-not",
        optionLabel: "Yes, run it",
      }),
    ).toBeNull();
  });

  it("refuses when the card's label does not match the live request", () => {
    const request = approvalRequest([
      { decision: "accept", label: "Yes, run it" },
      { decision: "decline", label: "No" },
    ]);
    expect(
      firstMateRequestReply({
        activity: request,
        selectedOptionId: "accept",
        optionLabel: "Deploy to production",
      }),
    ).toBeNull();
    expect(
      firstMateRequestReply({
        activity: singleQuestionRequest,
        selectedOptionId: "answer:0",
        optionLabel: "On disk",
      }),
    ).toBeNull();
  });

  it("refuses an answer position the live request does not have", () => {
    for (const selectedOptionId of ["answer:2", "answer:-1", "answer:x", "answer:", "0"]) {
      expect(
        firstMateRequestReply({
          activity: singleQuestionRequest,
          selectedOptionId,
          optionLabel: "In memory",
        }),
      ).toBeNull();
    }
  });
});
