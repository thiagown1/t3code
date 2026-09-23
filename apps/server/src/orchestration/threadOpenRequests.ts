/**
 * threadOpenRequests - the single definition of "this thread is blocked on you".
 *
 * An approval or user-input request is open when the thread's retained
 * activities hold a `*.requested` with no later clearing activity for the same
 * requestId. Several places need that answer — the decider refuses to settle a
 * thread that still has one, and FirstMate turns them into decision cards — and
 * they must agree exactly: a divergent count either settles a thread the user
 * is still blocking on, or answers a request that is already gone.
 *
 * The clearing rules MUST match ProjectionPipeline's pending accounting.
 * `*.resolved` always clears; `provider.*.respond.failed` clears only when the
 * failure detail marks the request stale or unknown, because any other failure
 * leaves the request live on the provider.
 *
 * @module threadOpenRequests
 */
import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Every activity kind that can open or clear a request. Callers reading from
 * the projection pass this as an activity-kind filter so the scan sees the same
 * window without hydrating unrelated history.
 */
export const THREAD_REQUEST_ACTIVITY_KINDS = [
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
  "provider.approval.respond.failed",
  "provider.user-input.respond.failed",
] as const;

function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

/**
 * Open requests by requestId, in the order the thread raised them.
 *
 * Scans the read model's activities, which the projector caps at the most
 * recent 500 plus pending async questions. Async questions remain actionable
 * while the agent works, so they must not expire with the activity window.
 */
export function openRequests(
  thread: Pick<OrchestrationThread, "activities">,
): Map<string, OrchestrationThreadActivity> {
  const requests = new Map<string, OrchestrationThreadActivity>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      requests.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      requests.delete(requestId);
    }
  }
  return requests;
}
