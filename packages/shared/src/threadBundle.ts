import {
  ThreadBundle,
  ThreadId,
  type FirstMateDecision,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProjectId,
  type ThreadBundleImportPlan,
  type ThreadBundleImportStatus,
  type ThreadBundleOmissionKind,
  type ThreadBundleThread,
  type ThreadBundle as ThreadBundleType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
    readonly thread: OrchestrationThread;
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
  const seenOrigins = new Set<string>();
  const threads = [...bundle.threads]
    .map((thread) => {
      const key = originKey(thread.sourceEnvironmentId, thread.sourceThreadId);
      if (seenOrigins.has(key)) throw new Error(`Thread Bundle contains duplicate origin: ${key}`);
      seenOrigins.add(key);
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
    schemaVersion: 1,
    bundleId: bundle.bundleId,
    exportedAt: bundle.exportedAt,
    threads,
  };
}

export function serializeThreadBundle(bundle: ThreadBundleType): string {
  return `${JSON.stringify(normalizeThreadBundle(bundle), null, 2)}\n`;
}

export function parseThreadBundleJson(json: string): ThreadBundleType {
  const input: unknown = JSON.parse(json);
  const version =
    typeof input === "object" && input !== null && "schemaVersion" in input
      ? (input as { readonly schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (version !== 1) {
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
    canImport: items.length > 0 && items.every((item) => item.status === "ready"),
    items,
  };
}
