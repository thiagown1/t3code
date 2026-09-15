import type { ThreadBundleImportPlan, ThreadBundleImportStatus } from "@t3tools/contracts";

const STATUS_LABELS: Record<ThreadBundleImportStatus, string> = {
  ready: "Ready",
  duplicate: "Already imported",
  "missing-project": "Project not found",
  "ambiguous-project": "Multiple matching projects",
  "missing-provider": "Provider unavailable",
};

export function threadBundleImportStatusLabel(status: ThreadBundleImportStatus): string {
  return STATUS_LABELS[status];
}

export function summarizeThreadBundleImportPlan(plan: ThreadBundleImportPlan) {
  return plan.items.reduce(
    (summary, item) => ({
      threads: summary.threads + 1,
      readyThreads: summary.readyThreads + (item.status === "ready" ? 1 : 0),
      messages: summary.messages + item.messageCount,
      attachmentReferences: summary.attachmentReferences + item.attachmentReferenceCount,
      plans: summary.plans + item.proposedPlanCount,
      decisions: summary.decisions + item.resolvedDecisionCount,
      omissions: summary.omissions + item.omissionCount,
    }),
    {
      threads: 0,
      readyThreads: 0,
      messages: 0,
      attachmentReferences: 0,
      plans: 0,
      decisions: 0,
      omissions: 0,
    },
  );
}
