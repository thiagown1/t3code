import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

export const FirstMateTopicId = TrimmedNonEmptyString.pipe(Schema.brand("FirstMateTopicId"));
export type FirstMateTopicId = typeof FirstMateTopicId.Type;

export const FirstMateDecisionId = TrimmedNonEmptyString.pipe(Schema.brand("FirstMateDecisionId"));
export type FirstMateDecisionId = typeof FirstMateDecisionId.Type;

export const FirstMateTopicStage = Schema.Literals([
  "research",
  "planning",
  "implementation",
  "testing",
  "completed",
]);
export type FirstMateTopicStage = typeof FirstMateTopicStage.Type;

/**
 * What one finished round on a delegated thread produced, written by the cheap
 * text-generation model rather than by the agent that did the work. Distinct
 * from `FirstMateTopic.summary`, which is the author's description of what the
 * topic must achieve and never changes on its own.
 */
export const FirstMateRoundSummary = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  text: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
});
export type FirstMateRoundSummary = typeof FirstMateRoundSummary.Type;

export const FirstMateTopic = Schema.Struct({
  id: FirstMateTopicId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  stage: FirstMateTopicStage,
  threadId: Schema.NullOr(ThreadId),
  responsibleAgentId: Schema.NullOr(TrimmedNonEmptyString),
  // Only the newest round is kept. History belongs to the thread; the topic
  // carries just enough for the supervisor to reorient without reading it.
  latestRoundSummary: Schema.NullOr(FirstMateRoundSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type FirstMateTopic = typeof FirstMateTopic.Type;

export const FirstMateDecisionOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type FirstMateDecisionOption = typeof FirstMateDecisionOption.Type;

export const FirstMateDecisionSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["user-input", "approval"]),
    requestId: ApprovalRequestId,
    /**
     * Thread that raised the request. A provider request id is unique only
     * within one provider session, so the answer cannot be routed without it:
     * scanning threads for a matching id can land on the wrong request and
     * authorize work the user never saw. Decisions stored before this field
     * existed decode as `null` and are refused at delivery rather than guessed.
     */
    threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  }),
  Schema.Struct({
    kind: Schema.Literal("firstmate"),
    sourceId: TrimmedNonEmptyString,
  }),
]);
export type FirstMateDecisionSource = typeof FirstMateDecisionSource.Type;

export const FirstMateDecisionStatus = Schema.Literals(["pending", "resolved", "cancelled"]);
export type FirstMateDecisionStatus = typeof FirstMateDecisionStatus.Type;

export const FirstMateDecision = Schema.Struct({
  id: FirstMateDecisionId,
  projectId: ProjectId,
  /**
   * Topic the card belongs to, when one does. A pending provider request
   * belongs to the thread that raised it, and most threads carry no topic, so
   * the inbox would be empty if a topic were required to reach it. Decisions
   * stored before this field could be null still name their topic; ones stored
   * without the field at all decode as unowned.
   */
  topicId: Schema.NullOr(FirstMateTopicId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  source: FirstMateDecisionSource,
  question: TrimmedNonEmptyString,
  options: Schema.Array(FirstMateDecisionOption),
  recommendedOptionId: Schema.NullOr(TrimmedNonEmptyString),
  selectedOptionId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  blocking: Schema.Boolean,
  status: FirstMateDecisionStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type FirstMateDecision = typeof FirstMateDecision.Type;

export const FirstMateRoutingReason = Schema.Literals([
  "selected-topic",
  "explicit-mention",
  "user-confirmed",
]);
export type FirstMateRoutingReason = typeof FirstMateRoutingReason.Type;

export const FirstMateRoutingEvaluationMode = Schema.Literals(["off", "shadow"]);
export type FirstMateRoutingEvaluationMode = typeof FirstMateRoutingEvaluationMode.Type;

export const FirstMateRoutingEvaluation = Schema.Struct({
  candidateTopicId: Schema.NullOr(FirstMateTopicId),
  score: NonNegativeInt,
  outcome: Schema.Literals(["matched", "different", "no-candidate"]),
});
export type FirstMateRoutingEvaluation = typeof FirstMateRoutingEvaluation.Type;

export const FirstMateRoutingReceipt = Schema.Struct({
  messageId: MessageId,
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  topicId: FirstMateTopicId,
  destinationThreadId: ThreadId,
  reason: FirstMateRoutingReason,
  evaluation: Schema.NullOr(FirstMateRoutingEvaluation).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  routedAt: IsoDateTime,
});
export type FirstMateRoutingReceipt = typeof FirstMateRoutingReceipt.Type;

export const FirstMateWorkspaceState = Schema.Struct({
  projectId: ProjectId,
  supervisorThreadId: Schema.NullOr(ThreadId),
  selectedTopicId: Schema.NullOr(FirstMateTopicId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  topics: Schema.Array(FirstMateTopic),
  decisions: Schema.Array(FirstMateDecision),
  routingReceipts: Schema.Array(FirstMateRoutingReceipt).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  routingEvaluationMode: FirstMateRoutingEvaluationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  updatedAt: IsoDateTime,
});
export type FirstMateWorkspaceState = typeof FirstMateWorkspaceState.Type;

const FirstMateCommandBase = {
  commandId: CommandId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
};

const FirstMateTopicUpdateCommand = Schema.Struct({
  ...FirstMateCommandBase,
  type: Schema.Literal("firstmate.topic.update"),
  topicId: FirstMateTopicId,
  title: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  stage: Schema.optional(FirstMateTopicStage),
}).check(
  Schema.makeFilter(
    (input) =>
      input.title !== undefined ||
      input.summary !== undefined ||
      input.stage !== undefined ||
      "topic update must change at least one field",
  ),
);

export const FirstMateCommand = Schema.Union([
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.supervisor.link"),
    threadId: Schema.NullOr(ThreadId),
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.topic.create"),
    topicId: FirstMateTopicId,
    title: TrimmedNonEmptyString,
    summary: TrimmedNonEmptyString,
    stage: FirstMateTopicStage,
    threadId: Schema.NullOr(ThreadId),
    responsibleAgentId: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.topic.select"),
    topicId: FirstMateTopicId,
  }),
  FirstMateTopicUpdateCommand,
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.topic.delegate"),
    topicId: FirstMateTopicId,
    threadId: Schema.NullOr(ThreadId),
    responsibleAgentId: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.topic.record-round-summary"),
    topicId: FirstMateTopicId,
    threadId: ThreadId,
    turnId: TurnId,
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.routing-evaluation-mode.set"),
    mode: FirstMateRoutingEvaluationMode,
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.routing.record"),
    messageId: MessageId,
    sourceThreadId: ThreadId,
    topicId: FirstMateTopicId,
    destinationThreadId: ThreadId,
    reason: FirstMateRoutingReason,
    evaluation: Schema.NullOr(FirstMateRoutingEvaluation),
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.decision.open"),
    decisionId: FirstMateDecisionId,
    topicId: Schema.NullOr(FirstMateTopicId),
    source: FirstMateDecisionSource,
    question: TrimmedNonEmptyString,
    options: Schema.Array(FirstMateDecisionOption),
    recommendedOptionId: Schema.NullOr(TrimmedNonEmptyString),
    blocking: Schema.Boolean,
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.decision.resolve"),
    decisionId: FirstMateDecisionId,
    selectedOptionId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literal("firstmate.decision.cancel"),
    decisionId: FirstMateDecisionId,
  }),
]);
export type FirstMateCommand = typeof FirstMateCommand.Type;

export const FirstMateEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("firstmate.supervisor-linked"),
    projectId: ProjectId,
    threadId: Schema.NullOr(ThreadId),
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.topic-created"),
    topic: FirstMateTopic,
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.topic-selected"),
    projectId: ProjectId,
    topicId: FirstMateTopicId,
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.topic-updated"),
    projectId: ProjectId,
    topicId: FirstMateTopicId,
    title: Schema.optional(TrimmedNonEmptyString),
    summary: Schema.optional(TrimmedNonEmptyString),
    stage: Schema.optional(FirstMateTopicStage),
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.topic-delegated"),
    projectId: ProjectId,
    topicId: FirstMateTopicId,
    threadId: Schema.NullOr(ThreadId),
    responsibleAgentId: Schema.NullOr(TrimmedNonEmptyString),
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.topic-round-summary-recorded"),
    projectId: ProjectId,
    topicId: FirstMateTopicId,
    summary: FirstMateRoundSummary,
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.routing-evaluation-mode-set"),
    projectId: ProjectId,
    mode: FirstMateRoutingEvaluationMode,
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.routing-recorded"),
    messageId: MessageId,
    projectId: ProjectId,
    sourceThreadId: ThreadId,
    topicId: FirstMateTopicId,
    destinationThreadId: ThreadId,
    reason: FirstMateRoutingReason,
    evaluation: Schema.NullOr(FirstMateRoutingEvaluation).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.decision-opened"),
    decision: FirstMateDecision,
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.decision-resolved"),
    projectId: ProjectId,
    decisionId: FirstMateDecisionId,
    selectedOptionId: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("firstmate.decision-cancelled"),
    projectId: ProjectId,
    decisionId: FirstMateDecisionId,
    occurredAt: IsoDateTime,
  }),
]);
export type FirstMateEvent = typeof FirstMateEvent.Type;

export const FirstMateMachineAlertSummary = Schema.Struct({
  informational: NonNegativeInt,
  attention: NonNegativeInt,
  critical: NonNegativeInt,
});
export type FirstMateMachineAlertSummary = typeof FirstMateMachineAlertSummary.Type;
