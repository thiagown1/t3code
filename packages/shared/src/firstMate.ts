import type {
  FirstMateCommand,
  FirstMateDecision,
  FirstMateEvent,
  FirstMateTopic,
  FirstMateTopicId,
  FirstMateTopicOperationalStatus,
  FirstMateTopicReadModel,
  FirstMateTopicRuntimeFacts,
  FirstMateWorkspaceState,
  ProjectId,
} from "@t3tools/contracts";

export type FirstMateCommandRejection =
  | "project-mismatch"
  | "topic-already-exists"
  | "topic-not-found"
  | "decision-already-exists"
  | "decision-not-found"
  | "decision-not-pending"
  | "decision-option-not-found";

export type FirstMateCommandDecision =
  | { readonly accepted: true; readonly events: ReadonlyArray<FirstMateEvent> }
  | { readonly accepted: false; readonly reason: FirstMateCommandRejection };

export function createEmptyFirstMateWorkspace(
  projectId: ProjectId,
  now: string,
): FirstMateWorkspaceState {
  return {
    projectId,
    supervisorThreadId: null,
    selectedTopicId: null,
    topics: [],
    decisions: [],
    updatedAt: now,
  };
}

function reject(reason: FirstMateCommandRejection): FirstMateCommandDecision {
  return { accepted: false, reason };
}

export function decideFirstMateCommand(
  state: FirstMateWorkspaceState,
  command: FirstMateCommand,
): FirstMateCommandDecision {
  if (state.projectId !== command.projectId) return reject("project-mismatch");

  const topic =
    "topicId" in command ? state.topics.find((entry) => entry.id === command.topicId) : undefined;
  const decision =
    "decisionId" in command
      ? state.decisions.find((entry) => entry.id === command.decisionId)
      : undefined;

  switch (command.type) {
    case "firstmate.supervisor.link":
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.supervisor-linked",
            projectId: command.projectId,
            threadId: command.threadId,
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.topic.create":
      if (topic) return reject("topic-already-exists");
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.topic-created",
            topic: {
              id: command.topicId,
              projectId: command.projectId,
              title: command.title,
              summary: command.summary,
              stage: command.stage,
              threadId: command.threadId,
              responsibleAgentId: command.responsibleAgentId,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
              completedAt: command.stage === "completed" ? command.createdAt : null,
            },
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.topic.select":
      if (!topic) return reject("topic-not-found");
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.topic-selected",
            projectId: command.projectId,
            topicId: command.topicId,
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.topic.update":
      if (!topic) return reject("topic-not-found");
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.topic-updated",
            projectId: command.projectId,
            topicId: command.topicId,
            ...(command.title === undefined ? {} : { title: command.title }),
            ...(command.summary === undefined ? {} : { summary: command.summary }),
            ...(command.stage === undefined ? {} : { stage: command.stage }),
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.topic.delegate":
      if (!topic) return reject("topic-not-found");
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.topic-delegated",
            projectId: command.projectId,
            topicId: command.topicId,
            threadId: command.threadId,
            responsibleAgentId: command.responsibleAgentId,
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.decision.open":
      if (!topic) return reject("topic-not-found");
      if (decision) return reject("decision-already-exists");
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.decision-opened",
            decision: {
              id: command.decisionId,
              projectId: command.projectId,
              topicId: command.topicId,
              source: command.source,
              question: command.question,
              options: command.options,
              recommendedOptionId: command.recommendedOptionId,
              selectedOptionId: null,
              blocking: command.blocking,
              status: "pending",
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
              resolvedAt: null,
            },
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.decision.resolve":
    case "firstmate.decision.cancel":
      if (!decision) return reject("decision-not-found");
      if (decision.status !== "pending") return reject("decision-not-pending");
      if (command.type === "firstmate.decision.resolve") {
        if (!decision.options.some((option) => option.id === command.selectedOptionId)) {
          return reject("decision-option-not-found");
        }
        return {
          accepted: true,
          events: [
            {
              type: "firstmate.decision-resolved",
              projectId: command.projectId,
              decisionId: command.decisionId,
              selectedOptionId: command.selectedOptionId,
              occurredAt: command.createdAt,
            },
          ],
        };
      }
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.decision-cancelled",
            projectId: command.projectId,
            decisionId: command.decisionId,
            occurredAt: command.createdAt,
          },
        ],
      };
  }
}

function updateTopic(
  topics: ReadonlyArray<FirstMateTopic>,
  topicId: FirstMateTopic["id"],
  update: (topic: FirstMateTopic) => FirstMateTopic,
): ReadonlyArray<FirstMateTopic> {
  return topics.map((topic) => (topic.id === topicId ? update(topic) : topic));
}

function updateDecision(
  decisions: ReadonlyArray<FirstMateDecision>,
  decisionId: FirstMateDecision["id"],
  update: (decision: FirstMateDecision) => FirstMateDecision,
): ReadonlyArray<FirstMateDecision> {
  return decisions.map((decision) => (decision.id === decisionId ? update(decision) : decision));
}

export function projectFirstMateEvent(
  state: FirstMateWorkspaceState,
  event: FirstMateEvent,
): FirstMateWorkspaceState {
  if (event.type !== "firstmate.topic-created" && event.type !== "firstmate.decision-opened") {
    if (event.projectId !== state.projectId) return state;
  }

  switch (event.type) {
    case "firstmate.supervisor-linked":
      return { ...state, supervisorThreadId: event.threadId, updatedAt: event.occurredAt };

    case "firstmate.topic-created":
      if (event.topic.projectId !== state.projectId) return state;
      return {
        ...state,
        topics: [...state.topics.filter((topic) => topic.id !== event.topic.id), event.topic],
        updatedAt: event.occurredAt,
      };

    case "firstmate.topic-selected":
      return { ...state, selectedTopicId: event.topicId, updatedAt: event.occurredAt };

    case "firstmate.topic-updated":
      return {
        ...state,
        topics: updateTopic(state.topics, event.topicId, (topic) => ({
          ...topic,
          ...(event.title === undefined ? {} : { title: event.title }),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.stage === undefined ? {} : { stage: event.stage }),
          completedAt:
            event.stage === undefined
              ? topic.completedAt
              : event.stage === "completed"
                ? event.occurredAt
                : null,
          updatedAt: event.occurredAt,
        })),
        updatedAt: event.occurredAt,
      };

    case "firstmate.topic-delegated":
      return {
        ...state,
        topics: updateTopic(state.topics, event.topicId, (topic) => ({
          ...topic,
          threadId: event.threadId,
          responsibleAgentId: event.responsibleAgentId,
          updatedAt: event.occurredAt,
        })),
        updatedAt: event.occurredAt,
      };

    case "firstmate.decision-opened":
      if (event.decision.projectId !== state.projectId) return state;
      return {
        ...state,
        decisions: [
          ...state.decisions.filter((decision) => decision.id !== event.decision.id),
          event.decision,
        ],
        updatedAt: event.occurredAt,
      };

    case "firstmate.decision-resolved":
    case "firstmate.decision-cancelled":
      return {
        ...state,
        decisions: updateDecision(state.decisions, event.decisionId, (decision) => ({
          ...decision,
          status: event.type === "firstmate.decision-resolved" ? "resolved" : "cancelled",
          selectedOptionId:
            event.type === "firstmate.decision-resolved" ? event.selectedOptionId : null,
          updatedAt: event.occurredAt,
          resolvedAt: event.occurredAt,
        })),
        updatedAt: event.occurredAt,
      };
  }
}

export function replayFirstMateEvents(
  initial: FirstMateWorkspaceState,
  events: ReadonlyArray<FirstMateEvent>,
): FirstMateWorkspaceState {
  return events.reduce(projectFirstMateEvent, initial);
}

export type FirstMateMessageRouteReason = "selected-topic" | "explicit-mention";
export type FirstMateMessageRoutingFailure =
  | "no-selected-topic"
  | "selected-topic-not-found"
  | "mentioned-topic-not-found"
  | "multiple-topic-mentions"
  | "topic-not-delegated";

export type FirstMateMessageRoutingResult =
  | {
      readonly status: "routed";
      readonly reason: FirstMateMessageRouteReason;
      readonly topicId: FirstMateTopicId;
      readonly threadId: NonNullable<FirstMateTopic["threadId"]>;
      readonly message: string;
    }
  | {
      readonly status: "needs-confirmation";
      readonly reason: FirstMateMessageRoutingFailure;
      readonly candidateTopicIds: ReadonlyArray<FirstMateTopicId>;
    };

export function firstMateTopicMention(topicId: FirstMateTopicId): string {
  return `@topic:${encodeURIComponent(topicId)}`;
}

function mentionedFirstMateTopicIds(message: string): ReadonlyArray<string> {
  const matches = message.matchAll(/(?:^|\s)@topic:([^\s]+)/gu);
  const mentions: string[] = [];
  for (const match of matches) {
    const encoded = match[1];
    if (encoded === undefined) continue;
    try {
      const topicId = decodeURIComponent(encoded);
      if (!mentions.includes(topicId)) mentions.push(topicId);
    } catch {
      if (!mentions.includes(encoded)) mentions.push(encoded);
    }
  }
  return mentions;
}

function routeToTopic(
  topic: FirstMateTopic,
  reason: FirstMateMessageRouteReason,
  message: string,
): FirstMateMessageRoutingResult {
  if (topic.threadId === null) {
    return {
      status: "needs-confirmation",
      reason: "topic-not-delegated",
      candidateTopicIds: [topic.id],
    };
  }
  return {
    status: "routed",
    reason,
    topicId: topic.id,
    threadId: topic.threadId,
    message,
  };
}

/** Resolve one supervisor message without guessing between topics or threads. */
export function routeFirstMateMessage(
  state: FirstMateWorkspaceState,
  message: string,
): FirstMateMessageRoutingResult {
  const mentionedTopicIds = mentionedFirstMateTopicIds(message);
  if (mentionedTopicIds.length > 1) {
    const mentioned = new Set(mentionedTopicIds);
    return {
      status: "needs-confirmation",
      reason: "multiple-topic-mentions",
      candidateTopicIds: state.topics
        .filter((topic) => mentioned.has(topic.id))
        .map((topic) => topic.id),
    };
  }
  if (mentionedTopicIds.length === 1) {
    const topic = state.topics.find((entry) => entry.id === mentionedTopicIds[0]);
    return topic === undefined
      ? {
          status: "needs-confirmation",
          reason: "mentioned-topic-not-found",
          candidateTopicIds: [],
        }
      : routeToTopic(topic, "explicit-mention", message);
  }

  const selectedTopicId = state.selectedTopicId ?? null;
  if (selectedTopicId === null) {
    return {
      status: "needs-confirmation",
      reason: "no-selected-topic",
      candidateTopicIds: state.topics.map((topic) => topic.id),
    };
  }
  const selectedTopic = state.topics.find((topic) => topic.id === selectedTopicId);
  return selectedTopic === undefined
    ? {
        status: "needs-confirmation",
        reason: "selected-topic-not-found",
        candidateTopicIds: state.topics.map((topic) => topic.id),
      }
    : routeToTopic(selectedTopic, "selected-topic", message);
}

const stageStatus: Record<FirstMateTopic["stage"], FirstMateTopicOperationalStatus> = {
  research: "researching",
  planning: "planning",
  implementation: "implementing",
  testing: "testing",
  completed: "completed",
};

export function deriveFirstMateTopicStatus(
  topic: FirstMateTopic,
  facts: FirstMateTopicRuntimeFacts,
): FirstMateTopicOperationalStatus {
  if (
    facts.pendingUserInputCount > 0 ||
    facts.pendingApprovalCount > 0 ||
    facts.pendingFirstMateDecisionCount > 0
  ) {
    return "waiting-user";
  }
  if (facts.deliveryStatus !== null) return facts.deliveryStatus;
  if (facts.sessionStatus === "error" || facts.sessionStatus === "interrupted") return "blocked";
  if (facts.backgroundLiveness !== null) return facts.backgroundLiveness;
  if (topic.stage === "completed") return "completed";
  if (facts.sessionStatus === "starting") return "queued";
  return stageStatus[topic.stage];
}

export function deriveFirstMateTopicReadModel(
  topic: FirstMateTopic,
  facts: FirstMateTopicRuntimeFacts,
): FirstMateTopicReadModel {
  return {
    ...topic,
    operationalStatus: deriveFirstMateTopicStatus(topic, facts),
    pendingDecisionCount:
      facts.pendingUserInputCount +
      facts.pendingApprovalCount +
      facts.pendingFirstMateDecisionCount,
    machineAlerts: facts.machineAlerts,
  };
}
