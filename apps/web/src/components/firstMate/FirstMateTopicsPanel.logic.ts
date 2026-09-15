import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  FirstMateTopicId,
  FirstMateTopicOperationalStatus,
  ProjectId,
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
  readonly updatedAt: string;
}

export interface FirstMatePanelModel {
  readonly availability: FirstMatePanelAvailability;
  readonly projectCount: number;
  readonly items: ReadonlyArray<FirstMatePanelItem>;
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
  working: 6,
  monitoring: 7,
  testing: 8,
  implementing: 9,
  planning: 10,
  researching: 11,
  queued: 12,
  completed: 13,
};

export function buildFirstMatePanelModel(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
}): FirstMatePanelModel {
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
      items: [],
    };
  }

  const threadByKey = new Map(
    input.threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
  );
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
      return {
        key: `${project.environmentId}:${project.id}:${topic.id}`,
        environmentId: project.environmentId,
        projectId: project.id,
        projectTitle: project.title,
        topicId: topic.id,
        selected: workspace.selectedTopicId === topic.id,
        title: topic.title,
        summary: topic.summary,
        status: readModel.operationalStatus,
        pendingDecisionCount: readModel.pendingDecisionCount,
        responsibleAgentId: topic.responsibleAgentId,
        threadId: topic.threadId,
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

  return {
    availability: items.length === 0 ? "empty" : "ready",
    projectCount: visibleProjects.length,
    items,
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
  "waiting-deploy": "Waiting to deploy",
  "validating-deploy": "Validating deploy",
  "waiting-activation": "Waiting to activate",
  working: "Working",
  monitoring: "Monitoring",
  blocked: "Blocked",
  completed: "Completed",
};
