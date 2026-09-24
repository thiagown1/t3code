import type {
  FirstMateCommand,
  FirstMateDecision,
  FirstMateEvent,
  FirstMateRoutingEvaluation,
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
  | "decision-option-not-found"
  | "routing-already-recorded"
  | "routing-source-not-supervisor"
  | "routing-destination-mismatch"
  | "round-summary-already-recorded"
  | "round-summary-thread-mismatch";

const FIRST_MATE_ROUTING_RECEIPT_LIMIT = 50;

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
    routingReceipts: [],
    routingEvaluationMode: "off",
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
              latestRoundSummary: null,
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

    case "firstmate.topic.record-round-summary":
      if (!topic) return reject("topic-not-found");
      // A round summary is evidence about one thread. Once the topic is
      // delegated elsewhere, a summary still in flight for the old thread
      // describes work this topic no longer owns.
      if (topic.threadId !== command.threadId) return reject("round-summary-thread-mismatch");
      if (topic.latestRoundSummary?.turnId === command.turnId) {
        return reject("round-summary-already-recorded");
      }
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.topic-round-summary-recorded",
            projectId: command.projectId,
            topicId: command.topicId,
            summary: {
              threadId: command.threadId,
              turnId: command.turnId,
              text: command.text,
              generatedAt: command.createdAt,
            },
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.routing.record":
      if (!topic) return reject("topic-not-found");
      if (state.routingReceipts.some((receipt) => receipt.messageId === command.messageId)) {
        return reject("routing-already-recorded");
      }
      if (state.supervisorThreadId !== command.sourceThreadId) {
        return reject("routing-source-not-supervisor");
      }
      if (topic.threadId !== command.destinationThreadId) {
        return reject("routing-destination-mismatch");
      }
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.routing-recorded",
            messageId: command.messageId,
            projectId: command.projectId,
            sourceThreadId: command.sourceThreadId,
            topicId: command.topicId,
            destinationThreadId: command.destinationThreadId,
            reason: command.reason,
            evaluation: command.evaluation,
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.routing-evaluation-mode.set":
      return {
        accepted: true,
        events: [
          {
            type: "firstmate.routing-evaluation-mode-set",
            projectId: command.projectId,
            mode: command.mode,
            occurredAt: command.createdAt,
          },
        ],
      };

    case "firstmate.decision.open":
      // A card names a topic only when one owns the work. A provider request
      // belongs to the thread that raised it, which usually has no topic at
      // all; only a topic the command does name has to exist.
      if (command.topicId !== null && !topic) return reject("topic-not-found");
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

    // A finished round is activity on the topic, so the bumped `updatedAt`
    // keeps recently worked topics at the top of the supervisor's listing.
    case "firstmate.topic-round-summary-recorded":
      return {
        ...state,
        topics: updateTopic(state.topics, event.topicId, (topic) => ({
          ...topic,
          latestRoundSummary: event.summary,
          updatedAt: event.occurredAt,
        })),
        updatedAt: event.occurredAt,
      };

    case "firstmate.routing-recorded":
      return {
        ...state,
        routingReceipts: [
          ...state.routingReceipts.filter((receipt) => receipt.messageId !== event.messageId),
          {
            messageId: event.messageId,
            projectId: event.projectId,
            sourceThreadId: event.sourceThreadId,
            topicId: event.topicId,
            destinationThreadId: event.destinationThreadId,
            reason: event.reason,
            evaluation: event.evaluation,
            routedAt: event.occurredAt,
          },
        ].slice(-FIRST_MATE_ROUTING_RECEIPT_LIMIT),
        updatedAt: event.occurredAt,
      };

    case "firstmate.routing-evaluation-mode-set":
      return {
        ...state,
        routingEvaluationMode: event.mode,
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
  | "topic-not-delegated"
  | "topic-is-supervisor";

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
  state: FirstMateWorkspaceState,
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
  if (topic.threadId === state.supervisorThreadId) {
    return {
      status: "needs-confirmation",
      reason: "topic-is-supervisor",
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
      : routeToTopic(state, topic, "explicit-mention", message);
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
    : routeToTopic(state, selectedTopic, "selected-topic", message);
}

const FIRST_MATE_ROUTING_STOP_WORDS = new Set([
  "and",
  "com",
  "continue",
  "das",
  "dos",
  "for",
  "para",
  "por",
  "please",
  "the",
  "uma",
]);

function firstMateRoutingTokens(value: string): ReadonlySet<string> {
  const normalized = value
    .replaceAll(/(?:^|\s)@topic:[^\s]+/gu, " ")
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US");
  return new Set(
    (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (token) => token.length >= 3 && !FIRST_MATE_ROUTING_STOP_WORDS.has(token),
    ),
  );
}

/**
 * Score an automatic route in shadow mode. The result is evidence only: callers
 * must keep the deterministic or user-confirmed topic as the real destination.
 */
export type FirstMateRoutingCandidateScore = {
  readonly topicId: FirstMateTopicId;
  readonly score: number;
};

/** Return the ordered lexical scores used by the shadow evaluator. */
export function scoreFirstMateRoutingCandidates(
  state: FirstMateWorkspaceState,
  message: string,
): ReadonlyArray<FirstMateRoutingCandidateScore> {
  const messageTokens = firstMateRoutingTokens(message);
  return state.topics
    .filter((topic) => topic.threadId !== null && topic.threadId !== state.supervisorThreadId)
    .map((topic) => {
      const titleTokens = firstMateRoutingTokens(topic.title);
      const summaryTokens = firstMateRoutingTokens(topic.summary);
      let score = 0;
      for (const token of messageTokens) {
        if (titleTokens.has(token)) score += 3;
        if (summaryTokens.has(token)) score += 1;
      }
      return { topicId: topic.id, score };
    })
    .sort((left, right) => right.score - left.score || left.topicId.localeCompare(right.topicId));
}

export function evaluateFirstMateAutomaticRouting(
  state: FirstMateWorkspaceState,
  message: string,
  authoritativeTopicId: FirstMateTopicId,
): FirstMateRoutingEvaluation | null {
  if (state.routingEvaluationMode !== "shadow") return null;

  const scored = scoreFirstMateRoutingCandidates(state, message);
  const best = scored[0];
  const runnerUp = scored[1];
  if (best === undefined || best.score < 3 || best.score === runnerUp?.score) {
    return { candidateTopicId: null, score: best?.score ?? 0, outcome: "no-candidate" };
  }
  return {
    candidateTopicId: best.topicId,
    score: best.score,
    outcome: best.topicId === authoritativeTopicId ? "matched" : "different",
  };
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
  if (facts.deliveryStatus === "done") return "completed";
  if (facts.deliveryStatus !== null) return facts.deliveryStatus;
  if (facts.sessionStatus === "error" || facts.sessionStatus === "interrupted") return "blocked";
  if (facts.backgroundLiveness !== null) return facts.backgroundLiveness;
  // A topic the supervisor closed can be picked up again in its thread; while
  // that thread runs, "completed" would hide live work.
  if (topic.stage === "completed") {
    return facts.sessionStatus === "running" ? "working" : "completed";
  }
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
