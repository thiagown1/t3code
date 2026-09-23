import {
  THREAD_PROVIDER_HANDOFF_MAX_MESSAGES,
  ThreadProviderHandoffRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  parseThreadProviderHandoff,
  sanitizeThreadProviderHandoff,
  serializeThreadProviderHandoff,
  type ThreadProviderHandoffSanitizationInput,
} from "./threadProviderHandoff.ts";

const NOW = "2026-09-16T12:00:00.000Z";

function input(): ThreadProviderHandoffSanitizationInput {
  return {
    handoffId: "handoff-one",
    threadId: "thread-one",
    source: { providerInstanceId: "claude-work", driver: "claude", model: "sonnet" },
    target: { providerInstanceId: "codex-work", driver: "codex", model: "gpt-5" },
    reason: "quota",
    sequence: 7,
    sourceTurnId: "turn-seven",
    projectId: "project-one",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/provider-handoff",
    messages: [
      {
        id: "message-one",
        role: "user",
        text: "Continue from the verified checkpoint.",
        attachments: [
          {
            id: "attachment-one",
            type: "image",
            name: "evidence.png",
            mimeType: "image/png",
            sizeBytes: 123,
            source: { path: "C:\\Users\\private\\evidence.png" },
            data: "raw-content-must-not-cross",
          },
        ],
        context: { selectedFiles: ["C:\\Users\\private\\secret.ts"] },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "message-streaming",
        role: "assistant",
        text: "unfinished-content",
        streaming: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "message-tool",
        role: "assistant",
        text: "tool summary",
        toolPayload: { headers: { authorization: "Bearer hidden" } },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "message-reasoning",
        role: "assistant",
        text: "private thought",
        reasoning: "raw chain of thought",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [
      {
        id: "plan-one",
        planMarkdown: "1. Validate\n2. Continue",
        implementedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    resolvedDecisions: [
      {
        id: "decision-one",
        question: "May the provider continue?",
        source: { kind: "approval", requestId: "approval-secret" },
        selectedOptionId: "continue",
        resolvedAt: NOW,
      },
    ],
    createdAt: NOW,
  };
}

describe("ThreadProviderHandoff", () => {
  it("keeps the persisted lifecycle record separate from portable context", () => {
    const decodeRecord = Schema.decodeUnknownSync(ThreadProviderHandoffRecord);
    const record = decodeRecord({
      schemaVersion: 1,
      handoffId: "handoff-one",
      threadId: "thread-one",
      source: { providerInstanceId: "claude-work", driver: "claude", model: "sonnet" },
      target: { providerInstanceId: "codex-work", driver: "codex", model: "gpt-5" },
      reason: "quota",
      sequence: 7,
      state: "requested",
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(record.state).toBe("requested");
    expect(record.contextHash).toBeUndefined();
    expect(record.envelopeHash).toBeUndefined();
    expect("context" in record).toBe(false);
  });

  it("builds a deterministic, versioned, reference-only portable envelope", () => {
    const first = sanitizeThreadProviderHandoff(input());
    const second = sanitizeThreadProviderHandoff(input());
    const serialized = serializeThreadProviderHandoff(first);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.envelopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parseThreadProviderHandoff(serialized)).toEqual(first);
    expect(first.context.messages).toHaveLength(1);
    expect(first.context.messages[0]?.attachments).toEqual([
      {
        sourceAttachmentId: "attachment-one",
        type: "image",
        name: "evidence.png",
        mimeType: "image/png",
        sizeBytes: 123,
        availability: "reference-only",
      },
    ]);
    expect(first.context.resolvedDecisions).toEqual([
      {
        sourceDecisionId: "decision-one",
        selectedOptionId: "continue",
        resolvedAt: NOW,
      },
    ]);
    expect(first.omissions).toEqual(
      expect.arrayContaining([
        { kind: "approval", count: 1 },
        { kind: "attachment-content", count: 1 },
        { kind: "attachment-source", count: 1 },
        { kind: "message-context", count: 2 },
        { kind: "question", count: 1 },
        { kind: "streaming-message", count: 1 },
        { kind: "tool-payload", count: 1 },
      ]),
    );
    expect(serialized).not.toMatch(
      /raw-content|Users\\private|unfinished-content|tool summary|Bearer hidden|private thought|chain of thought|approval-secret|May the provider/i,
    );
    expect(serialized).not.toMatch(
      /"(?:session|cursor|credentials|headers|env|reasoning|toolPayload|approval|question|streaming|path)"\s*:/i,
    );
  });

  it("keeps relative references and web URLs while omitting local Unix paths", () => {
    const envelope = sanitizeThreadProviderHandoff({
      ...input(),
      messages: [
        {
          id: "portable-message",
          role: "user",
          text: "Read src/config.ts and https://example.com/docs/config",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      proposedPlans: [
        {
          id: "local-plan",
          planMarkdown: "Read /workspace/private/plan.md",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    expect(envelope.context.messages).toHaveLength(1);
    expect(envelope.context.proposedPlans).toEqual([]);
    expect(envelope.omissions).toContainEqual({ kind: "absolute-path", count: 1 });
    expect(parseThreadProviderHandoff(serializeThreadProviderHandoff(envelope))).toEqual(envelope);
  });

  it("fails closed on forbidden metadata, limits, secrets, absolute paths, and tampering", () => {
    expect(() =>
      sanitizeThreadProviderHandoff({ ...input(), providerSessionId: "provider-secret" }),
    ).toThrow(/forbidden field/i);
    expect(() =>
      sanitizeThreadProviderHandoff({
        ...input(),
        messages: Array.from({ length: THREAD_PROVIDER_HANDOFF_MAX_MESSAGES + 1 }, () => ({})),
      }),
    ).toThrow(/message limit/i);
    expect(
      sanitizeThreadProviderHandoff({
        ...input(),
        messages: [
          {
            id: "secret-message",
            role: "user",
            text: "api_key=abcdefghijklmnop",
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: "path-message",
            role: "user",
            text: "Read C:\\Users\\private\\secret.ts",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }).context.messages,
    ).toEqual([]);
    for (const absolutePath of [
      "/workspace/private/secret.ts",
      "/mnt/c/Users/private/secret.ts",
      "/srv/t3/config.json",
      "/data/t3/state.sqlite",
    ]) {
      expect(
        sanitizeThreadProviderHandoff({
          ...input(),
          messages: [
            {
              id: `path-${absolutePath}`,
              role: "user",
              text: `Read ${absolutePath}`,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }).context.messages,
      ).toEqual([]);
    }

    const envelope = sanitizeThreadProviderHandoff(input());
    expect(() =>
      serializeThreadProviderHandoff({
        ...envelope,
        context: { ...envelope.context, branch: "tampered" },
      }),
    ).toThrow(/context hash mismatch/i);
    expect(() =>
      parseThreadProviderHandoff(
        serializeThreadProviderHandoff(envelope).replace('"reason":"quota"', '"reason":"user"'),
      ),
    ).toThrow(/envelope hash mismatch/i);
    expect(() =>
      parseThreadProviderHandoff(
        serializeThreadProviderHandoff(envelope).replace("{", '{"sessionId":"secret",'),
      ),
    ).toThrow(/forbidden field/i);
  });
});
