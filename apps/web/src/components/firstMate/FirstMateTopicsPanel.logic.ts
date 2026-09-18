import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  FirstMateTopicId,
  FirstMateTopicOperationalStatus,
  FirstMateRoutingEvaluationMode,
  PullRequestCheckStatus,
  ProjectId,
  ThreadPullRequestLink,
  ThreadId,
} from "@t3tools/contracts";
import { deriveFirstMateTopicReadModel } from "@t3tools/shared/firstMate";

export type FirstMatePanelAvailability = "ready" | "empty" | "unavailable";

export interface FirstMatePanelItem {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly topicId: FirstMateTopicId;
  readonly selected: boolean;
  readonly title: string;
  readonly summary: string;
  readonly status: FirstMateTopicOperationalStatus;
  readonly pendingDecisionCount: number;
  readonly responsibleAgentId: string | null;
  readonly threadId: ThreadId | null;
  readonly pullRequests: ReadonlyArray<FirstMatePanelPullRequest>;
  readonly postMergeActionRequired: boolean;
  readonly updatedAt: string;
}

export type FirstMatePanelPullRequestStatus =
  | "syncing"
  | "stale"
  | "waiting-ci"
  | "action-required"
  | "failing"
  | "inconclusive"
  | "draft"
  | "conflicting"
  | "ready-to-merge"
  | "merged"
  | "closed"
  | "checks-unavailable";

export interface FirstMatePanelPullRequest {
  readonly key: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly syncedAt: string | null;
  readonly status: FirstMatePanelPullRequestStatus;
  readonly checks: Readonly<Record<PullRequestCheckStatus, number>>;
}

/**
 * The thread a project talks to FirstMate in. `threadTitle` is null when that
 * thread is not in the visible shell, which is the only way the user can tell
 * a stale link from a live one.
 */
export interface FirstMatePanelSupervisor {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly threadId: ThreadId;
  readonly threadTitle: string | null;
}

export interface FirstMatePanelModel {
  readonly availability: FirstMatePanelAvailability;
  readonly projectCount: number;
  readonly supervisors: ReadonlyArray<FirstMatePanelSupervisor>;
  readonly items: ReadonlyArray<FirstMatePanelItem>;
  readonly routingEvaluation: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly mode: FirstMateRoutingEvaluationMode;
  } | null;
}

const ZERO_MACHINE_ALERTS = {
  informational: 0,
  attention: 0,
  critical: 0,
} as const;

const statusPriority: Record<FirstMateTopicOperationalStatus, number> = {
  "waiting-user": 0,
  blocked: 1,
  "waiting-deploy": 2,
  "validating-deploy": 3,
  "waiting-activation": 4,
  "waiting-ci": 5,
  "ready-to-merge": 6,
  working: 7,
  monitoring: 8,
  testing: 9,
  implementing: 10,
  planning: 11,
  researching: 12,
  queued: 13,
  completed: 14,
};

const FIRST_MATE_PULL_REQUEST_STALE_AFTER_MS = 3 * 60 * 1_000;

const EMPTY_CHECK_COUNTS: Readonly<Record<PullRequestCheckStatus, number>> = {
  pending: 0,
  "action-required": 0,
  success: 0,
  failure: 0,
  skipped: 0,
  neutral: 0,
  cancelled: 0,
};

function pullRequestStatus(
  link: ThreadPullRequestLink,
  checks: Readonly<Record<PullRequestCheckStatus, number>>,
  nowMs: number,
): FirstMatePanelPullRequestStatus {
  const snapshot = link.snapshot;
  if (snapshot === null) return "syncing";
  if (snapshot.state === "merged") return "merged";
  if (snapshot.state === "closed") return "closed";
  const syncedAtMs = Date.parse(snapshot.syncedAt);
  if (!Number.isFinite(syncedAtMs) || nowMs - syncedAtMs > FIRST_MATE_PULL_REQUEST_STALE_AFTER_MS) {
    return "stale";
  }
  if (checks["action-required"] > 0) return "action-required";
  if (checks.failure > 0 || snapshot.checksState === "failing") return "failing";
  if (checks.pending > 0 || snapshot.checksState === "pending") return "waiting-ci";
  if (checks.skipped + checks.neutral + checks.cancelled > 0) return "inconclusive";
  if (snapshot.isDraft) return "draft";
  if (snapshot.mergeability === "conflicting") return "conflicting";
  if (checks.success > 0 || snapshot.checksState === "passing") return "ready-to-merge";
  return "checks-unavailable";
}

export function firstMatePanelPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
  nowMs: number,
): ReadonlyArray<FirstMatePanelPullRequest> {
  return links
    .filter((link) => link.source !== "stack-dismissed")
    .map((link) => {
      const counts = { ...EMPTY_CHECK_COUNTS };
      for (const check of link.snapshot?.checks ?? []) counts[check.status] += 1;
      return {
        key: `${link.host}:${link.repository}#${link.number}`,
        repository: link.repository,
        number: link.number,
        url: link.url,
        title: link.snapshot?.title ?? null,
        headSha: link.snapshot?.headSha ?? null,
        syncedAt: link.snapshot?.syncedAt ?? null,
        status: pullRequestStatus(link, counts, nowMs),
        checks: counts,
      };
    });
}

function statusFromPullRequests(
  current: FirstMateTopicOperationalStatus,
  pullRequests: ReadonlyArray<FirstMatePanelPullRequest>,
): FirstMateTopicOperationalStatus {
  if (pullRequests.length === 0 || current === "waiting-user") return current;
  if (pullRequests.every((pullRequest) => pullRequest.status === "merged")) return "waiting-user";
  if (
    pullRequests.some((pullRequest) =>
      ["action-required", "failing", "inconclusive", "conflicting", "stale"].includes(
        pullRequest.status,
      ),
    )
  ) {
    return "blocked";
  }
  if (pullRequests.some((pullRequest) => ["syncing", "waiting-ci"].includes(pullRequest.status))) {
    return "waiting-ci";
  }
  const open = pullRequests.filter(
    (pullRequest) => pullRequest.status !== "merged" && pullRequest.status !== "closed",
  );
  return open.length > 0 && open.every((pullRequest) => pullRequest.status === "ready-to-merge")
    ? "ready-to-merge"
    : current;
}

export function buildFirstMatePanelModel(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly nowMs?: number;
}): FirstMatePanelModel {
  const nowMs = input.nowMs ?? Date.now();
  const visibleProjects = input.projects.filter(
    (project) =>
      input.scopedProjectKeys === null ||
      input.scopedProjectKeys.has(`${project.environmentId}:${project.id}`),
  );
  const firstMateProjects = visibleProjects.filter((project) => project.firstMate !== undefined);
  if (firstMateProjects.length === 0) {
    return {
      availability: "unavailable",
      projectCount: visibleProjects.length,
      supervisors: [],
      items: [],
      routingEvaluation: null,
    };
  }

  const threadByKey = new Map(
    input.threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
  );
  const supervisors = firstMateProjects.flatMap((project): FirstMatePanelSupervisor[] => {
    const threadId = project.firstMate?.supervisorThreadId ?? null;
    if (threadId === null) return [];
    return [
      {
        key: `${project.environmentId}:${project.id}`,
        environmentId: project.environmentId,
        projectId: project.id,
        projectTitle: project.title,
        threadId,
        threadTitle: threadByKey.get(`${project.environmentId}:${threadId}`)?.title ?? null,
      },
    ];
  });
  const items = firstMateProjects.flatMap((project) => {
    const workspace = project.firstMate;
    if (workspace === null || workspace === undefined) return [];
    return workspace.topics.map((topic): FirstMatePanelItem => {
      const thread =
        topic.threadId === null
          ? null
          : (threadByKey.get(`${project.environmentId}:${topic.threadId}`) ?? null);
      const pendingFirstMateDecisionCount = workspace.decisions.filter(
        (decision) => decision.topicId === topic.id && decision.status === "pending",
      ).length;
      const readModel = deriveFirstMateTopicReadModel(topic, {
        sessionStatus: thread?.session?.status ?? null,
        pendingUserInputCount: thread?.hasPendingUserInput === true ? 1 : 0,
        pendingApprovalCount: thread?.hasPendingApprovals === true ? 1 : 0,
        pendingFirstMateDecisionCount,
        backgroundLiveness: thread?.backgroundLiveness ?? null,
        deliveryStatus: thread?.deliveryStatus ?? null,
        machineAlerts: ZERO_MACHINE_ALERTS,
      });
      const pullRequests = firstMatePanelPullRequests(thread?.pullRequests ?? [], nowMs);
      const postMergeActionRequired =
        pullRequests.length > 0 &&
        pullRequests.every((pullRequest) => pullRequest.status === "merged") &&
        (thread?.deliveryStatus == null || thread.deliveryStatus === "waiting-ci");
      return {
        key: `${project.environmentId}:${project.id}:${topic.id}`,
        environmentId: project.environmentId,
        projectId: project.id,
        projectTitle: project.title,
        topicId: topic.id,
        selected: workspace.selectedTopicId === topic.id,
        title: topic.title,
        summary: topic.summary,
        status:
          thread?.deliveryStatus == null || thread.deliveryStatus === "waiting-ci"
            ? statusFromPullRequests(readModel.operationalStatus, pullRequests)
            : readModel.operationalStatus,
        pendingDecisionCount: readModel.pendingDecisionCount,
        responsibleAgentId: topic.responsibleAgentId,
        threadId: topic.threadId,
        pullRequests,
        postMergeActionRequired,
        updatedAt: topic.updatedAt,
      };
    });
  });
  items.sort((left, right) => {
    const priority = statusPriority[left.status] - statusPriority[right.status];
    if (priority !== 0) return priority;
    const recency = right.updatedAt.localeCompare(left.updatedAt);
    return recency !== 0 ? recency : left.key.localeCompare(right.key);
  });

  const evaluationProject =
    firstMateProjects.find((project) => project.firstMate?.selectedTopicId != null) ??
    (firstMateProjects.length === 1 ? firstMateProjects[0] : undefined);

  return {
    availability: items.length === 0 ? "empty" : "ready",
    projectCount: visibleProjects.length,
    supervisors,
    items,
    routingEvaluation:
      evaluationProject?.firstMate != null
        ? {
            environmentId: evaluationProject.environmentId,
            projectId: evaluationProject.id,
            mode: evaluationProject.firstMate.routingEvaluationMode,
          }
        : null,
  };
}

export const FIRST_MATE_STATUS_LABELS: Record<FirstMateTopicOperationalStatus, string> = {
  queued: "Queued",
  researching: "Researching",
  planning: "Planning",
  implementing: "Implementing",
  testing: "Testing",
  "waiting-user": "Waiting for you",
  "waiting-ci": "Waiting for CI",
  "ready-to-merge": "Ready to merge",
  "waiting-deploy": "Waiting to deploy",
  "validating-deploy": "Validating deploy",
  "waiting-activation": "Waiting to activate",
  working: "Working",
  monitoring: "Monitoring",
  blocked: "Blocked",
  completed: "Completed",
};
