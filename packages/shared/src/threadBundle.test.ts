import type {
  FirstMateDecision,
  OrchestrationProject,
  OrchestrationThread,
  ProjectId,
  ThreadBundle,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadBundle,
  buildThreadBundleImportPlan,
  embedThreadBundleAttachments,
  decodeThreadBundleAttachment,
  MAX_THREAD_BUNDLE_BYTES,
  parseThreadBundleJson,
  serializeThreadBundle,
  threadBundleTargetThreadId,
} from "./threadBundle.ts";

const NOW = "2026-09-15T18:00:00.000Z";

function sourceEntry() {
  const project = {
    id: "project-source",
    title: "Turbo Station",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/turbo-station",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://token-secret@github.com/acme/turbo-station.git",
      },
      rootPath: "C:\\Users\\secret\\turbo_station",
      provider: "github",
      owner: "acme",
      name: "turbo-station",
    },
  } as unknown as OrchestrationProject;
  const thread = {
    id: "thread-source",
    projectId: "project-source",
    title: "Investigate CI",
    modelSelection: { instanceId: "codex-work", model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "codex/investigate-ci",
    worktreePath: "C:\\Users\\secret\\worktree",
    messages: [
      {
        id: "message-user",
        role: "user",
        text: "Keep this message",
        context: { selectedFiles: ["C:\\Users\\secret\\credentials.json"] },
        attachments: [
          {
            type: "image",
            id: "attachment-image",
            name: "evidence.png",
            mimeType: "image/png",
            sizeBytes: 123,
            source: {
              kind: "snap-shot",
              capturedAt: NOW,
              appName: "Secrets",
              windowTitle: "token-window-secret",
              accessibleText: "private-accessibility-secret",
            },
          },
        ],
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "message-streaming",
        role: "assistant",
        text: "unfinished-live-secret",
        turnId: null,
        streaming: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [
      {
        id: "plan-source",
        turnId: null,
        planMarkdown: "1. Inspect\n2. Fix",
        implementedAt: null,
        implementationThreadId: "implementation-thread-secret",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    activities: [
      {
        id: "activity-source",
        tone: "tool",
        kind: "tool",
        summary: "Ran a tool",
        payload: { token: "activity-token-secret" },
        turnId: null,
        createdAt: NOW,
      },
    ],
    checkpoints: [
      {
        turnId: "turn-source",
        checkpointTurnCount: 1,
        checkpointRef: "checkpoint-secret",
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: NOW,
      },
    ],
    session: {
      threadId: "thread-source",
      status: "running",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: "turn-source",
      lastError: "session-secret",
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as OrchestrationThread;
  const decisions = [
    {
      id: "decision-resolved",
      projectId: "project-source",
      topicId: "topic-source",
      source: { kind: "approval", requestId: "approval-secret" },
      question: "Deploy after merge?",
      options: [{ id: "yes", label: "Yes", description: "Wait for authorization" }],
      recommendedOptionId: "yes",
      selectedOptionId: "yes",
      blocking: true,
      status: "resolved",
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: NOW,
    },
    {
      id: "decision-pending",
      projectId: "project-source",
      topicId: "topic-source",
      source: { kind: "user-input", requestId: "pending-request-secret" },
      question: "Pending question",
      options: [{ id: "one", label: "One", description: "Pending" }],
      recommendedOptionId: null,
      selectedOptionId: null,
      blocking: true,
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: null,
    },
  ] as unknown as ReadonlyArray<FirstMateDecision>;
  return { project, thread, decisions };
}

function bundle(): ThreadBundle {
  return buildThreadBundle({
    bundleId: "transfer-one",
    exportedAt: NOW,
    sourceEnvironmentId: "desk-source",
    entries: [sourceEntry()],
  });
}

describe("Thread Bundle", () => {
  it("serializes allowed conversation content and omits live or sensitive structured state", () => {
    const value = bundle();
    const exported = serializeThreadBundle(value);

    expect(exported).toBe(serializeThreadBundle(value));
    expect(parseThreadBundleJson(exported)).toEqual(value);
    expect(value.threads[0]?.messages.map((message) => message.text)).toEqual([
      "Keep this message",
    ]);
    expect(value.threads[0]?.resolvedDecisions).toHaveLength(1);
    expect(value.threads[0]?.messages[0]?.attachments[0]).toEqual({
      sourceAttachmentId: "attachment-image",
      type: "image",
      name: "evidence.png",
      mimeType: "image/png",
      sizeBytes: 123,
      availability: "reference-only",
    });
    expect(exported).not.toMatch(
      /token-secret|credentials\.json|token-window-secret|private-accessibility-secret|unfinished-live-secret|implementation-thread-secret|activity-token-secret|checkpoint-secret|session-secret|approval-secret|pending-request-secret/i,
    );
    expect(exported).not.toMatch(/"(?:worktreePath|session|context|source)"\s*:/);
    expect(value.threads[0]?.omissions).toEqual(
      expect.arrayContaining([
        { kind: "active-streaming-message", count: 1 },
        { kind: "message-context", count: 1 },
        { kind: "attachment-content", count: 1 },
        { kind: "attachment-source", count: 1 },
        { kind: "pending-decision", count: 1 },
        { kind: "session", count: 1 },
        { kind: "worktree-path", count: 1 },
      ]),
    );
  });

  it("rejects incompatible schema versions and duplicate origins", () => {
    expect(() => parseThreadBundleJson('{"schemaVersion":3}')).toThrow(
      "Unsupported Thread Bundle schema version: 3",
    );
    const value = bundle();
    expect(() =>
      serializeThreadBundle({ ...value, threads: [value.threads[0]!, value.threads[0]!] }),
    ).toThrow(/duplicate origin/);
    expect(() =>
      serializeThreadBundle({
        ...value,
        threads: [
          {
            ...value.threads[0]!,
            messages: [value.threads[0]!.messages[0]!, value.threads[0]!.messages[0]!],
          },
        ],
      }),
    ).toThrow(/duplicate message ID/);
  });

  it("carries complete attachment bytes in v2 with independently verified SHA-256", () => {
    const value = bundle();
    const original = value.threads[0]!;
    const source = {
      ...value,
      threads: [
        {
          ...original,
          messages: original.messages.map((message) => ({
            ...message,
            attachments: message.attachments.map((attachment) => ({ ...attachment, sizeBytes: 3 })),
          })),
        },
      ],
    };
    const portable = embedThreadBundleAttachments(source, () => new TextEncoder().encode("abc"));
    expect(portable.schemaVersion).toBe(2);
    const attachment = portable.threads[0]!.messages[0]!.attachments[0]!;
    expect(attachment).toMatchObject({
      availability: "embedded",
      contentBase64: "YWJj",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sizeBytes: 3,
    });
    expect(
      portable.threads[0]!.omissions.some((omission) => omission.kind === "attachment-content"),
    ).toBe(false);
    expect(
      portable.threads[0]!.omissions.some((omission) => omission.kind === "attachment-source"),
    ).toBe(true);
    expect(parseThreadBundleJson(serializeThreadBundle(portable))).toEqual(portable);
    if (attachment.availability !== "embedded") throw new Error("Expected embedded attachment");
    expect(decodeThreadBundleAttachment(attachment)).toEqual(new TextEncoder().encode("abc"));
    expect(() => decodeThreadBundleAttachment({ ...attachment, sha256: "0".repeat(64) })).toThrow(
      /hash mismatch/,
    );
    expect(() => decodeThreadBundleAttachment({ ...attachment, sizeBytes: 4 })).toThrow(/size/);
    expect(() =>
      decodeThreadBundleAttachment({ ...attachment, contentBase64: "YWJj\n" }),
    ).toThrow();
    expect(() => serializeThreadBundle({ ...portable, schemaVersion: 1 })).toThrow(/v1/);
  });

  it("never promotes missing, partial, unsupported or oversized files to complete v2", () => {
    expect(() => serializeThreadBundle({ ...bundle(), schemaVersion: 2 })).toThrow(
      /requires every attachment/,
    );
    expect(() =>
      embedThreadBundleAttachments(bundle(), () => {
        throw new Error("Missing source file");
      }),
    ).toThrow(/Missing source file/);
    expect(() => embedThreadBundleAttachments(bundle(), () => new Uint8Array(122))).toThrow(
      /size mismatch/,
    );
    const source = bundle();
    const thread = source.threads[0]!;
    const message = thread.messages[0]!;
    const attachment = message.attachments[0]!;
    const changed = (patch: { type?: string; sizeBytes?: number }): ThreadBundle => ({
      ...source,
      threads: [
        {
          ...thread,
          messages: [
            { ...message, attachments: [{ ...attachment, ...patch } as typeof attachment] },
          ],
        },
      ],
    });
    expect(() =>
      embedThreadBundleAttachments(changed({ type: "future-attachment" }), () => new Uint8Array()),
    ).toThrow(/type cannot be restored/);
    expect(() =>
      embedThreadBundleAttachments(
        changed({ sizeBytes: 5 * 1024 * 1024 + 1 }),
        () => new Uint8Array(),
      ),
    ).toThrow(/file size limit/);
  });

  it("bounds pasted JSON before parsing and rejects attachment integrity mismatches from JSON", () => {
    expect(() => parseThreadBundleJson(" ".repeat(MAX_THREAD_BUNDLE_BYTES + 1))).toThrow(
      /JSON size limit/,
    );
    const source = bundle();
    const complete = embedThreadBundleAttachments(source, () => new Uint8Array(123));
    const json = serializeThreadBundle(complete).replace(
      /"sha256": "[a-f0-9]{64}"/,
      `"sha256": "${"f".repeat(64)}"`,
    );
    expect(() => parseThreadBundleJson(json)).toThrow(/hash mismatch/);
  });

  it("rejects inconsistent identities and enforces the aggregate decoded-byte limit", () => {
    const source = bundle();
    const complete = embedThreadBundleAttachments(source, () => new Uint8Array(123));
    const thread = complete.threads[0]!;
    const message = thread.messages[0]!;
    const attachment = message.attachments[0]!;
    expect(() =>
      serializeThreadBundle({
        ...complete,
        threads: [
          {
            ...thread,
            messages: [
              message,
              {
                ...message,
                sourceMessageId: "another-message" as typeof message.sourceMessageId,
                attachments: [{ ...attachment, name: "different-name.png" }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/inconsistent metadata/);

    const bytes = new Uint8Array(4 * 1024 * 1024);
    const large = embedThreadBundleAttachments(
      {
        ...source,
        threads: [
          {
            ...source.threads[0]!,
            messages: [
              {
                ...source.threads[0]!.messages[0]!,
                attachments: [
                  {
                    ...source.threads[0]!.messages[0]!.attachments[0]!,
                    sizeBytes: bytes.length,
                  },
                ],
              },
            ],
          },
        ],
      },
      () => bytes,
    );
    const largeThread = large.threads[0]!;
    const largeMessage = largeThread.messages[0]!;
    expect(() =>
      serializeThreadBundle({
        ...large,
        threads: [
          {
            ...largeThread,
            messages: [
              largeMessage,
              ...[1, 2].map((index) => ({
                ...largeMessage,
                sourceMessageId: `message-${index}` as typeof message.sourceMessageId,
              })),
            ],
          },
        ],
      }),
    ).toThrow(/total size limit/);
  });

  it("dry-runs project, provider, and duplicate conflicts atomically", () => {
    const value = bundle();
    const projectId = "project-target" as ProjectId;
    const threadId = value.threads[0]!.sourceThreadId as ThreadId;
    const target = {
      projectId,
      title: "Turbo Station target",
      repositoryCanonicalKey: "github.com/acme/turbo-station",
      providerInstanceIds: ["codex-work"],
    };

    const originalPlan = buildThreadBundleImportPlan({
      bundle: value,
      targetProjects: [target],
      existingOrigins: [],
    });
    const alteredPlan = buildThreadBundleImportPlan({
      bundle: {
        ...value,
        threads: value.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) => ({
            ...message,
            text: "changed after review",
          })),
        })),
      },
      targetProjects: [target],
      existingOrigins: [],
    });
    expect(originalPlan.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(alteredPlan.bundleSha256).not.toBe(originalPlan.bundleSha256);
    expect(alteredPlan.items).toEqual(originalPlan.items);

    expect(
      buildThreadBundleImportPlan({ bundle: value, targetProjects: [target], existingOrigins: [] }),
    ).toMatchObject({
      bundleId: "transfer-one",
      canImport: true,
      items: [
        {
          sourceEnvironmentId: "desk-source",
          sourceThreadId: threadId,
          targetThreadId: threadBundleTargetThreadId({
            sourceEnvironmentId: "desk-source",
            sourceThreadId: threadId,
          }),
          status: "ready",
          targetProjectId: projectId,
          messageCount: 1,
          attachmentReferenceCount: 1,
          proposedPlanCount: 1,
          resolvedDecisionCount: 1,
        },
      ],
    });
    expect(
      buildThreadBundleImportPlan({
        bundle: value,
        targetProjects: [target],
        existingOrigins: [{ sourceEnvironmentId: "desk-source", sourceThreadId: threadId }],
      }).items[0]?.status,
    ).toBe("duplicate");
    expect(
      buildThreadBundleImportPlan({ bundle: value, targetProjects: [], existingOrigins: [] })
        .items[0]?.status,
    ).toBe("missing-project");
    expect(
      buildThreadBundleImportPlan({
        bundle: value,
        targetProjects: [target, { ...target, projectId: "project-other" as ProjectId }],
        existingOrigins: [],
      }).items[0]?.status,
    ).toBe("ambiguous-project");
    expect(
      buildThreadBundleImportPlan({
        bundle: value,
        targetProjects: [{ ...target, providerInstanceIds: [] }],
        existingOrigins: [],
      }).items[0]?.status,
    ).toBe("missing-provider");
  });
});
