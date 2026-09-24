import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  FirstMateDecision,
  FirstMateDecisionId,
  FirstMateTopic,
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
  readonly topicId: FirstMateTopicId | null;
  /** Whether {@link originTitle} names a topic or the thread that asked. */
  readonly originKind: "topic" | "thread";
  readonly originTitle: string;
  readonly responsibleAgentId: string | null;
  readonly threadId: ThreadId | null;
  readonly source: FirstMateDecision["source"];
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

/**
 * Where a card came from, as something the user can read before answering.
 *
 * Most cards now come from a thread nobody delegated a topic to, so a topic is
 * no longer the only label. A card that can name neither a topic nor a live
 * thread is dropped: answering a question with no visible origin is deciding in
 * the dark, and the server refuses to deliver to a thread this client cannot
 * see anyway.
 */
function decisionOrigin(
  topic: FirstMateTopic | null,
  thread: EnvironmentThreadShell | null,
): { readonly kind: "topic" | "thread"; readonly title: string } | null {
  if (topic !== null) return { kind: "topic", title: topic.title };
  if (thread !== null) return { kind: "thread", title: thread.title };
  return null;
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
  const threadsByKey = new Map(
    input.threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
  );
  const items = visibleProjects.flatMap((project) => {
    const workspace = project.firstMate;
    if (workspace === null || workspace === undefined) return [];
    const topicsById = new Map(workspace.topics.map((topic) => [topic.id, topic] as const));
    return workspace.decisions.flatMap((decision): FirstMateDecisionInboxItem[] => {
      if (decision.status !== "pending") return [];
      const topic = decision.topicId === null ? null : (topicsById.get(decision.topicId) ?? null);
      // A topic id naming nothing describes work this workspace lost track of.
      if (decision.topicId !== null && topic === null) return [];

      // A provider request names its own thread, and that is where answering
      // the card lands. A question the supervisor asked itself belongs to
      // whichever thread its topic is delegated to.
      const sourceThreadId =
        decision.source.kind === "firstmate" ? (topic?.threadId ?? null) : decision.source.threadId;
      const thread =
        sourceThreadId === null
          ? null
          : (threadsByKey.get(`${project.environmentId}:${sourceThreadId}`) ?? null);
      const origin = decisionOrigin(topic, thread);
      if (origin === null) return [];

      return [
        {
          key: `${project.environmentId}:${project.id}:${decision.id}`,
          environmentId: project.environmentId,
          projectId: project.id,
          projectTitle: project.title,
          decisionId: decision.id,
          topicId: decision.topicId,
          originKind: origin.kind,
          originTitle: origin.title,
          // Without a topic naming who owns the work, the provider the thread
          // runs is the closest honest answer to "who is asking".
          responsibleAgentId:
            topic !== null ? topic.responsibleAgentId : (thread?.modelSelection.instanceId ?? null),
          threadId: thread?.id ?? null,
          source: decision.source,
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
