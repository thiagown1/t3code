import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  FirstMateDecision,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export interface FirstMateDecisionInboxItem {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly decisionId: FirstMateDecisionId;
  readonly topicId: FirstMateTopicId;
  readonly topicTitle: string;
  readonly responsibleAgentId: string | null;
  readonly threadId: ThreadId | null;
  readonly question: string;
  readonly options: FirstMateDecision["options"];
  readonly recommendedOptionId: string | null;
  readonly blocking: boolean;
  readonly updatedAt: string;
}

export interface FirstMateDecisionInboxModel {
  readonly projectCount: number;
  readonly items: ReadonlyArray<FirstMateDecisionInboxItem>;
}

export function buildFirstMateDecisionInboxModel(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
}): FirstMateDecisionInboxModel {
  const visibleProjects = input.projects.filter(
    (project) =>
      input.scopedProjectKeys === null ||
      input.scopedProjectKeys.has(`${project.environmentId}:${project.id}`),
  );
  const threadKeys = new Set(input.threads.map((thread) => `${thread.environmentId}:${thread.id}`));
  const items = visibleProjects.flatMap((project) => {
    const workspace = project.firstMate;
    if (workspace === null || workspace === undefined) return [];
    const topicsById = new Map(workspace.topics.map((topic) => [topic.id, topic] as const));
    return workspace.decisions.flatMap((decision): FirstMateDecisionInboxItem[] => {
      if (decision.status !== "pending") return [];
      const topic = topicsById.get(decision.topicId);
      if (topic === undefined) return [];
      const threadId =
        topic.threadId !== null && threadKeys.has(`${project.environmentId}:${topic.threadId}`)
          ? topic.threadId
          : null;
      return [
        {
          key: `${project.environmentId}:${project.id}:${decision.id}`,
          environmentId: project.environmentId,
          projectId: project.id,
          projectTitle: project.title,
          decisionId: decision.id,
          topicId: decision.topicId,
          topicTitle: topic.title,
          responsibleAgentId: topic.responsibleAgentId,
          threadId,
          question: decision.question,
          options: decision.options,
          recommendedOptionId: decision.recommendedOptionId,
          blocking: decision.blocking,
          updatedAt: decision.updatedAt,
        },
      ];
    });
  });

  items.sort((left, right) => {
    if (left.blocking !== right.blocking) return left.blocking ? -1 : 1;
    const recency = right.updatedAt.localeCompare(left.updatedAt);
    return recency !== 0 ? recency : left.key.localeCompare(right.key);
  });

  return { projectCount: visibleProjects.length, items };
}
