import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationSessionStatus, ThreadDeliveryStatus } from "./orchestration.ts";

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

export const FirstMateTopic = Schema.Struct({
  id: FirstMateTopicId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  stage: FirstMateTopicStage,
  threadId: Schema.NullOr(ThreadId),
  responsibleAgentId: Schema.NullOr(TrimmedNonEmptyString),
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
  topicId: FirstMateTopicId,
  source: FirstMateDecisionSource,
  question: TrimmedNonEmptyString,
  options: Schema.Array(FirstMateDecisionOption),
  recommendedOptionId: Schema.NullOr(TrimmedNonEmptyString),
  blocking: Schema.Boolean,
  status: FirstMateDecisionStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type FirstMateDecision = typeof FirstMateDecision.Type;

export const FirstMateWorkspaceState = Schema.Struct({
  projectId: ProjectId,
  supervisorThreadId: Schema.NullOr(ThreadId),
  topics: Schema.Array(FirstMateTopic),
  decisions: Schema.Array(FirstMateDecision),
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
    type: Schema.Literal("firstmate.decision.open"),
    decisionId: FirstMateDecisionId,
    topicId: FirstMateTopicId,
    source: FirstMateDecisionSource,
    question: TrimmedNonEmptyString,
    options: Schema.Array(FirstMateDecisionOption),
    recommendedOptionId: Schema.NullOr(TrimmedNonEmptyString),
    blocking: Schema.Boolean,
  }),
  Schema.Struct({
    ...FirstMateCommandBase,
    type: Schema.Literals(["firstmate.decision.resolve", "firstmate.decision.cancel"]),
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
    type: Schema.Literal("firstmate.decision-opened"),
    decision: FirstMateDecision,
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literals(["firstmate.decision-resolved", "firstmate.decision-cancelled"]),
    projectId: ProjectId,
    decisionId: FirstMateDecisionId,
    occurredAt: IsoDateTime,
  }),
]);
export type FirstMateEvent = typeof FirstMateEvent.Type;

export const FirstMateTopicOperationalStatus = Schema.Literals([
  "queued",
  "researching",
  "planning",
  "implementing",
  "testing",
  "waiting-user",
  "waiting-ci",
  "waiting-deploy",
  "validating-deploy",
  "waiting-activation",
  "working",
  "monitoring",
  "blocked",
  "completed",
]);
export type FirstMateTopicOperationalStatus = typeof FirstMateTopicOperationalStatus.Type;

export const FirstMateMachineAlertSummary = Schema.Struct({
  informational: NonNegativeInt,
  attention: NonNegativeInt,
  critical: NonNegativeInt,
});
export type FirstMateMachineAlertSummary = typeof FirstMateMachineAlertSummary.Type;

export const FirstMateTopicRuntimeFacts = Schema.Struct({
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  pendingUserInputCount: NonNegativeInt,
  pendingApprovalCount: NonNegativeInt,
  pendingFirstMateDecisionCount: NonNegativeInt,
  backgroundLiveness: Schema.NullOr(Schema.Literals(["working", "monitoring"])),
  deliveryStatus: Schema.NullOr(ThreadDeliveryStatus),
  machineAlerts: FirstMateMachineAlertSummary,
});
export type FirstMateTopicRuntimeFacts = typeof FirstMateTopicRuntimeFacts.Type;

export const FirstMateTopicReadModel = Schema.Struct({
  ...FirstMateTopic.fields,
  operationalStatus: FirstMateTopicOperationalStatus,
  pendingDecisionCount: NonNegativeInt,
  machineAlerts: FirstMateMachineAlertSummary,
});
export type FirstMateTopicReadModel = typeof FirstMateTopicReadModel.Type;
