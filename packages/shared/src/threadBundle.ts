import {
  MAX_THREAD_BUNDLE_BYTES,
  THREAD_BUNDLE_MAX_ATTACHMENT_BYTES,
  THREAD_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES,
  ThreadBundle,
  ThreadId,
  type FirstMateDecision,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type ProjectId,
  type ThreadBundleImportPlan,
  type ThreadBundleImportStatus,
  type ThreadBundleOmissionKind,
  type ThreadBundleThread,
  type ThreadBundleEmbeddedAttachment,
  type ThreadBundleAttachmentReference,
  type ThreadBundle as ThreadBundleType,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export { MAX_THREAD_BUNDLE_BYTES } from "@t3tools/contracts";

export function decodeThreadBundleAttachment(
  attachment: ThreadBundleEmbeddedAttachment,
): Uint8Array {
  if (attachment.contentBase64.length > 4 * Math.ceil(THREAD_BUNDLE_MAX_ATTACHMENT_BYTES / 3)) {
    throw new Error("Thread Bundle attachment exceeds the file size limit");
  }
  const bytes = Result.getOrThrow(Encoding.decodeBase64(attachment.contentBase64));
  if (Encoding.encodeBase64(bytes) !== attachment.contentBase64) {
    throw new Error("Thread Bundle attachment is not canonical base64");
  }
  if (
    bytes.length === 0 ||
    bytes.length !== attachment.sizeBytes ||
    bytes.length > THREAD_BUNDLE_MAX_ATTACHMENT_BYTES
  ) {
    throw new Error("Thread Bundle attachment size does not match its content");
  }
  const digest = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== attachment.sha256) throw new Error("Thread Bundle attachment hash mismatch");
  return bytes;
}

/** Offline/native adapters supply bytes; no host filesystem path enters the portable bundle. */
export function embedThreadBundleAttachments(
  bundle: ThreadBundleType,
  readAttachment: (
    attachment: ThreadBundleAttachmentReference,
    thread: ThreadBundleThread,
  ) => Uint8Array,
): ThreadBundleType {
  const normalized = normalizeThreadBundle(bundle);
  let totalBytes = 0;
  return normalizeThreadBundle({
    ...normalized,
    schemaVersion: 2,
    threads: normalized.threads.map((thread) => ({
      ...thread,
      messages: thread.messages.map((message) => ({
        ...message,
        attachments: message.attachments.map((attachment) => {
          if (attachment.availability === "embedded") return attachment;
          if (attachment.type !== "image" && attachment.type !== "file") {
            throw new Error("Thread Bundle attachment type cannot be restored");
          }
          if (attachment.sizeBytes > THREAD_BUNDLE_MAX_ATTACHMENT_BYTES) {
            throw new Error("Thread Bundle attachment exceeds the file size limit");
          }
          const bytes = readAttachment(attachment, thread);
          totalBytes += bytes.length;
          if (bytes.length !== attachment.sizeBytes)
            throw new Error("Thread Bundle attachment size mismatch");
          if (totalBytes > THREAD_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES) {
            throw new Error("Thread Bundle attachments exceed the total size limit");
          }
          return {
            ...attachment,
            type: attachment.type,
            availability: "embedded" as const,
            sha256: Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(
              "",
            ),
            contentBase64: Encoding.encodeBase64(bytes),
          };
        }),
      })),
      omissions: thread.omissions.filter((omission) => omission.kind !== "attachment-content"),
    })),
  });
}

type ThreadBundleBuildMessage = Pick<
  OrchestrationMessage,
  "id" | "role" | "text" | "streaming" | "createdAt" | "updatedAt"
> & {
  readonly attachments?:
    | ReadonlyArray<{
        readonly id: string;
        readonly type: string;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
        readonly source?: unknown;
      }>
    | undefined;
  readonly context?: unknown;
};

type ThreadBundleBuildThread = Pick<
  OrchestrationThread,
  | "id"
  | "projectId"
  | "title"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "branch"
  | "createdAt"
  | "updatedAt"
> & {
  readonly worktreePath: unknown | null;
  readonly messages: ReadonlyArray<ThreadBundleBuildMessage>;
  readonly proposedPlans: ReadonlyArray<
    Pick<
      OrchestrationProposedPlan,
      "id" | "planMarkdown" | "implementedAt" | "createdAt" | "updatedAt"
    >
  >;
  readonly activities: { readonly length: number };
  readonly checkpoints: { readonly length: number };
  readonly session: unknown | null;
};

const decodeThreadBundle = Schema.decodeUnknownSync(ThreadBundle);

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function originKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

function assertUnique(values: ReadonlyArray<string>, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Thread Bundle contains duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function incrementOmission(
  counts: Map<ThreadBundleOmissionKind, number>,
  kind: ThreadBundleOmissionKind,
  count = 1,
) {
  if (count <= 0) return;
  counts.set(kind, (counts.get(kind) ?? 0) + count);
}

export function buildThreadBundle(input: {
  readonly bundleId: string;
  readonly exportedAt: string;
  readonly sourceEnvironmentId: string;
  readonly entries: ReadonlyArray<{
    readonly project: Pick<OrchestrationProject, "id" | "title" | "repositoryIdentity">;
    readonly thread: ThreadBundleBuildThread;
    readonly decisions?: ReadonlyArray<FirstMateDecision>;
  }>;
}): ThreadBundleType {
  const threads = input.entries.map(({ project, thread, decisions = [] }): ThreadBundleThread => {
    if (project.id !== thread.projectId) {
      throw new Error(`Thread Bundle project does not own thread: ${thread.id}`);
    }
    if (decisions.some((decision) => decision.projectId !== project.id)) {
      throw new Error(`Thread Bundle decision does not belong to project: ${project.id}`);
    }
    const omissionCounts = new Map<ThreadBundleOmissionKind, number>();
    const messages = thread.messages
      .filter((message) => {
        if (!message.streaming) return true;
        incrementOmission(omissionCounts, "active-streaming-message");
        return false;
      })
      .map((message) => {
        if (message.context) incrementOmission(omissionCounts, "message-context");
        const attachments = (message.attachments ?? []).map((attachment) => {
          incrementOmission(omissionCounts, "attachment-content");
          if ("source" in attachment && attachment.source) {
            incrementOmission(omissionCounts, "attachment-source");
          }
          return {
            sourceAttachmentId: attachment.id,
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            availability: "reference-only" as const,
          };
        });
        return {
          sourceMessageId: message.id,
          role: message.role,
          text: message.text,
          attachments,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        };
      });

    incrementOmission(omissionCounts, "activity", thread.activities.length);
    incrementOmission(omissionCounts, "checkpoint", thread.checkpoints.length);
    incrementOmission(omissionCounts, "session", thread.session ? 1 : 0);
    incrementOmission(omissionCounts, "worktree-path", thread.worktreePath ? 1 : 0);

    const resolvedDecisions = decisions
      .filter((decision) => {
        if (decision.status === "pending") {
          incrementOmission(omissionCounts, "pending-decision");
          return false;
        }
        if (decision.status === "cancelled") {
          incrementOmission(omissionCounts, "cancelled-decision");
          return false;
        }
        if (decision.selectedOptionId === null || decision.resolvedAt === null) {
          throw new Error(`Thread Bundle resolved decision is incomplete: ${decision.id}`);
        }
        return true;
      })
      .map((decision) => ({
        sourceDecisionId: decision.id,
        question: decision.question,
        options: [...decision.options],
        recommendedOptionId: decision.recommendedOptionId,
        selectedOptionId: decision.selectedOptionId!,
        blocking: decision.blocking,
        resolvedAt: decision.resolvedAt!,
      }));

    return {
      sourceEnvironmentId: input.sourceEnvironmentId,
      sourceThreadId: thread.id,
      project: {
        sourceProjectId: project.id,
        title: project.title,
        ...(project.repositoryIdentity?.canonicalKey
          ? { repositoryCanonicalKey: project.repositoryIdentity.canonicalKey }
          : {}),
        ...(project.repositoryIdentity?.provider
          ? { repositoryProvider: project.repositoryIdentity.provider }
          : {}),
        ...(project.repositoryIdentity?.owner
          ? { repositoryOwner: project.repositoryIdentity.owner }
          : {}),
        ...(project.repositoryIdentity?.name
          ? { repositoryName: project.repositoryIdentity.name }
          : {}),
      },
      title: thread.title,
      preferredModel: {
        providerInstanceRef: thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      messages,
      proposedPlans: thread.proposedPlans.map((plan) => ({
        sourcePlanId: plan.id,
        planMarkdown: plan.planMarkdown,
        implementedAt: plan.implementedAt,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      })),
      resolvedDecisions,
      omissions: [...omissionCounts]
        .map(([kind, count]) => ({ kind, count }))
        .sort((left, right) => compareText(left.kind, right.kind)),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  });
  return normalizeThreadBundle({
    schemaVersion: 1,
    bundleId: input.bundleId,
    exportedAt: input.exportedAt,
    threads,
  });
}

export function normalizeThreadBundle(bundle: ThreadBundleType): ThreadBundleType {
  if (bundle.schemaVersion !== 1 && bundle.schemaVersion !== 2) {
    throw new Error("Unsupported Thread Bundle schema version");
  }
  // RPC callers already have a decoded object, so enforce the product bound here
  // as well as at the pasted/file JSON boundary.
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > MAX_THREAD_BUNDLE_BYTES) {
    throw new Error("Thread Bundle exceeds the JSON size limit");
  }
  let totalBytes = 0;
  const seenOrigins = new Set<string>();
  const threads = [...bundle.threads]
    .map((thread) => {
      const key = originKey(thread.sourceEnvironmentId, thread.sourceThreadId);
      if (seenOrigins.has(key)) throw new Error(`Thread Bundle contains duplicate origin: ${key}`);
      seenOrigins.add(key);
      const attachmentIdentities = new Map<string, string>();
      for (const message of thread.messages) {
        assertUnique(
          message.attachments.map((attachment) => attachment.sourceAttachmentId),
          "attachment ID in message",
        );
        for (const attachment of message.attachments) {
          if (bundle.schemaVersion === 1 && attachment.availability !== "reference-only") {
            throw new Error("Thread Bundle v1 cannot contain embedded attachments");
          }
          if (bundle.schemaVersion === 2 && attachment.availability !== "embedded") {
            throw new Error("Thread Bundle v2 requires every attachment file");
          }
          if (attachment.availability === "embedded") {
            const identity = JSON.stringify([
              attachment.type,
              attachment.name,
              attachment.mimeType,
              attachment.sizeBytes,
              attachment.sha256,
            ]);
            const prior = attachmentIdentities.get(attachment.sourceAttachmentId);
            if (prior !== undefined && prior !== identity) {
              throw new Error("Thread Bundle attachment ID has inconsistent metadata or content");
            }
            attachmentIdentities.set(attachment.sourceAttachmentId, identity);
            totalBytes += attachment.sizeBytes;
            if (totalBytes > THREAD_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES) {
              throw new Error("Thread Bundle attachments exceed the total size limit");
            }
            decodeThreadBundleAttachment(attachment);
          }
        }
      }
      assertUnique(
        thread.messages.map((message) => message.sourceMessageId),
        `message ID in ${key}`,
      );
      assertUnique(
        thread.proposedPlans.map((plan) => plan.sourcePlanId),
        `plan ID in ${key}`,
      );
      assertUnique(
        thread.resolvedDecisions.map((decision) => decision.sourceDecisionId),
        `decision ID in ${key}`,
      );
      const omissionCounts = new Map<ThreadBundleOmissionKind, number>();
      for (const omission of thread.omissions) {
        incrementOmission(omissionCounts, omission.kind, omission.count);
      }
      return {
        ...thread,
        messages: [...thread.messages],
        proposedPlans: [...thread.proposedPlans].sort((left, right) =>
          compareText(left.sourcePlanId, right.sourcePlanId),
        ),
        resolvedDecisions: [...thread.resolvedDecisions].sort((left, right) =>
          compareText(left.sourceDecisionId, right.sourceDecisionId),
        ),
        omissions: [...omissionCounts]
          .map(([kind, count]) => ({ kind, count }))
          .sort((left, right) => compareText(left.kind, right.kind)),
      };
    })
    .sort((left, right) =>
      compareText(
        originKey(left.sourceEnvironmentId, left.sourceThreadId),
        originKey(right.sourceEnvironmentId, right.sourceThreadId),
      ),
    );
  return {
    schemaVersion: bundle.schemaVersion,
    bundleId: bundle.bundleId,
    exportedAt: bundle.exportedAt,
    threads,
  };
}

export function serializeThreadBundle(bundle: ThreadBundleType): string {
  const json = `${JSON.stringify(normalizeThreadBundle(bundle), null, 2)}\n`;
  if (new TextEncoder().encode(json).length > MAX_THREAD_BUNDLE_BYTES) {
    throw new Error("Thread Bundle exceeds the JSON size limit");
  }
  return json;
}

export function parseThreadBundleJson(json: string): ThreadBundleType {
  if (new TextEncoder().encode(json).length > MAX_THREAD_BUNDLE_BYTES) {
    throw new Error("Thread Bundle exceeds the JSON size limit");
  }
  const input: unknown = JSON.parse(json);
  const version =
    typeof input === "object" && input !== null && "schemaVersion" in input
      ? (input as { readonly schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported Thread Bundle schema version: ${String(version ?? "missing")}`);
  }
  return normalizeThreadBundle(decodeThreadBundle(input));
}

export function threadBundleTargetThreadId(input: {
  readonly sourceEnvironmentId: string;
  readonly sourceThreadId: ThreadId;
}): ThreadId {
  return ThreadId.make(
    `bundle:${encodeURIComponent(input.sourceEnvironmentId)}:${encodeURIComponent(input.sourceThreadId)}`,
  );
}

export function buildThreadBundleImportPlan(input: {
  readonly bundle: ThreadBundleType;
  readonly targetProjects: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly title: string;
    readonly repositoryCanonicalKey?: string;
    readonly providerInstanceIds: ReadonlyArray<string>;
  }>;
  readonly existingOrigins: ReadonlyArray<{
    readonly sourceEnvironmentId: string;
    readonly sourceThreadId: ThreadId;
  }>;
}): ThreadBundleImportPlan {
  const existingOrigins = new Set(
    input.existingOrigins.map((origin) =>
      originKey(origin.sourceEnvironmentId, origin.sourceThreadId),
    ),
  );
  const items = normalizeThreadBundle(input.bundle).threads.map((thread) => {
    const duplicate = existingOrigins.has(
      originKey(thread.sourceEnvironmentId, thread.sourceThreadId),
    );
    const candidates = input.targetProjects.filter((project) =>
      thread.project.repositoryCanonicalKey
        ? project.repositoryCanonicalKey === thread.project.repositoryCanonicalKey
        : project.projectId === thread.project.sourceProjectId,
    );
    const target = candidates.length === 1 ? candidates[0]! : null;
    const status: ThreadBundleImportStatus = duplicate
      ? "duplicate"
      : candidates.length === 0
        ? "missing-project"
        : candidates.length > 1
          ? "ambiguous-project"
          : !target!.providerInstanceIds.includes(thread.preferredModel.providerInstanceRef)
            ? "missing-provider"
            : "ready";
    return {
      sourceEnvironmentId: thread.sourceEnvironmentId,
      sourceThreadId: thread.sourceThreadId,
      targetThreadId: threadBundleTargetThreadId(thread),
      title: thread.title,
      status,
      targetProjectId: target?.projectId ?? null,
      messageCount: thread.messages.length,
      attachmentReferenceCount: thread.messages.reduce(
        (count, message) => count + message.attachments.length,
        0,
      ),
      proposedPlanCount: thread.proposedPlans.length,
      resolvedDecisionCount: thread.resolvedDecisions.length,
      omissionCount: thread.omissions.reduce((count, omission) => count + omission.count, 0),
    };
  });
  return {
    bundleId: input.bundle.bundleId,
    bundleSha256: Array.from(
      sha256(new TextEncoder().encode(serializeThreadBundle(input.bundle))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
    canImport: items.length > 0 && items.every((item) => item.status === "ready"),
    items,
  };
}
