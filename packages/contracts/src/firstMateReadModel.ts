import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import { FirstMateMachineAlertSummary, FirstMateTopic } from "./firstMate.ts";
import { OrchestrationSessionStatus, ThreadDeliveryStatus } from "./orchestration.ts";

export const FirstMateTopicOperationalStatus = Schema.Literals([
  "queued",
  "researching",
  "planning",
  "implementing",
  "testing",
  "waiting-user",
  "waiting-ci",
  "ready-to-merge",
  "waiting-deploy",
  "validating-deploy",
  "waiting-activation",
  "working",
  "monitoring",
  "blocked",
  "completed",
]);
export type FirstMateTopicOperationalStatus = typeof FirstMateTopicOperationalStatus.Type;

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
