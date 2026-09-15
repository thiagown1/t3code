import type { ThreadBundle, ThreadBundleOmissionKind } from "@t3tools/contracts";
import { serializeThreadBundle } from "@t3tools/shared/threadBundle";

const OMISSION_LABELS: Record<
  ThreadBundleOmissionKind,
  { readonly singular: string; readonly plural: string }
> = {
  "active-streaming-message": {
    singular: "active streaming message",
    plural: "active streaming messages",
  },
  "message-context": { singular: "message context snapshot", plural: "message context snapshots" },
  "attachment-content": { singular: "attachment content", plural: "attachment contents" },
  "attachment-source": {
    singular: "attachment source location",
    plural: "attachment source locations",
  },
  activity: { singular: "activity record", plural: "activity records" },
  checkpoint: { singular: "checkpoint", plural: "checkpoints" },
  session: { singular: "runtime session", plural: "runtime sessions" },
  "pending-decision": { singular: "pending decision", plural: "pending decisions" },
  "cancelled-decision": { singular: "cancelled decision", plural: "cancelled decisions" },
  "worktree-path": { singular: "worktree path", plural: "worktree paths" },
};

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function sanitizeFilenameSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
  return normalized.slice(0, 64) || "conversation";
}

export interface ThreadBundleReviewSummary {
  readonly threadCount: number;
  readonly messageCount: number;
  readonly attachmentReferenceCount: number;
  readonly proposedPlanCount: number;
  readonly resolvedDecisionCount: number;
  readonly omissionCount: number;
  readonly omissions: ReadonlyArray<{
    readonly kind: ThreadBundleOmissionKind;
    readonly count: number;
  }>;
}

export function summarizeThreadBundle(bundle: ThreadBundle): ThreadBundleReviewSummary {
  const omissions = new Map<ThreadBundleOmissionKind, number>();
  let messageCount = 0;
  let attachmentReferenceCount = 0;
  let proposedPlanCount = 0;
  let resolvedDecisionCount = 0;

  for (const thread of bundle.threads) {
    messageCount += thread.messages.length;
    attachmentReferenceCount += thread.messages.reduce(
      (count, message) => count + message.attachments.length,
      0,
    );
    proposedPlanCount += thread.proposedPlans.length;
    resolvedDecisionCount += thread.resolvedDecisions.length;
    for (const omission of thread.omissions) {
      omissions.set(omission.kind, (omissions.get(omission.kind) ?? 0) + omission.count);
    }
  }

  const sortedOmissions = [...omissions]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
  return {
    threadCount: bundle.threads.length,
    messageCount,
    attachmentReferenceCount,
    proposedPlanCount,
    resolvedDecisionCount,
    omissionCount: sortedOmissions.reduce((count, omission) => count + omission.count, 0),
    omissions: sortedOmissions,
  };
}

export function buildThreadBundleReviewMessage(bundle: ThreadBundle): string {
  const summary = summarizeThreadBundle(bundle);
  const title =
    summary.threadCount === 1 ? bundle.threads[0]?.title : `${summary.threadCount} conversations`;
  const omissionLines =
    summary.omissions.length === 0
      ? ["- No runtime or local-only state was present."]
      : summary.omissions.map(({ kind, count }) => {
          const labels = OMISSION_LABELS[kind];
          return `- ${formatCount(count, labels.singular, labels.plural)}`;
        });

  return [
    `Download Thread Bundle for “${title ?? "conversation"}”?`,
    "",
    "Portable content:",
    `- ${formatCount(summary.messageCount, "completed message")}`,
    `- ${formatCount(summary.proposedPlanCount, "proposed plan")}`,
    `- ${formatCount(summary.resolvedDecisionCount, "resolved FirstMate decision")}`,
    `- ${formatCount(summary.attachmentReferenceCount, "attachment reference")} (file contents are not included)`,
    "",
    `Omitted local/runtime state (${summary.omissionCount} records):`,
    ...omissionLines,
    "",
    "Message and plan text may contain sensitive information. Review the JSON before sharing it.",
  ].join("\n");
}

export function threadBundleDownloadName(bundle: ThreadBundle): string {
  const subject =
    bundle.threads.length === 1
      ? sanitizeFilenameSegment(bundle.threads[0]?.title ?? "conversation")
      : `${bundle.threads.length}-conversations`;
  const timestamp = bundle.exportedAt.replace(/[:.]/g, "-");
  return `t3-thread-bundle-${subject}-${timestamp}.json`;
}

export function downloadThreadBundle(bundle: ThreadBundle): string {
  const filename = threadBundleDownloadName(bundle);
  const url = URL.createObjectURL(
    new Blob([serializeThreadBundle(bundle)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return filename;
}
