/**
 * RuntimeReceiptBus - Internal checkpoint-reactor synchronization receipts.
 *
 * This service exists to expose short-lived orchestration milestones that are
 * useful in tests and harnesses but are not part of the production runtime
 * event model. `CheckpointReactor` publishes receipts such as baseline capture,
 * diff finalization, and turn-processing quiescence so integration tests can
 * wait for those exact points without inferring them indirectly from persisted
 * state.
 *
 * Production code should only call `publish`. Test code may subscribe via
 * `streamEventsForTest`, which is intentionally named to make the intended
 * usage explicit.
 *
 * @module RuntimeReceiptBus
 */
import {
  CheckpointRef,
  FirstMateTopicId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export const CheckpointBaselineCapturedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.baseline.captured"),
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  createdAt: IsoDateTime,
});
export type CheckpointBaselineCapturedReceipt = typeof CheckpointBaselineCapturedReceipt.Type;

export const CheckpointDiffFinalizedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.diff.finalized"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: Schema.Literals(["ready", "missing", "error"]),
  createdAt: IsoDateTime,
});
export type CheckpointDiffFinalizedReceipt = typeof CheckpointDiffFinalizedReceipt.Type;

export const TurnProcessingQuiescedReceipt = Schema.Struct({
  type: Schema.Literal("turn.processing.quiesced"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type TurnProcessingQuiescedReceipt = typeof TurnProcessingQuiescedReceipt.Type;

/**
 * One pass of the FirstMate round summariser over a finished turn. `outcome`
 * is reported for every pass, including the cheap ones that never reach a
 * model, so a test can wait on the decision instead of on a summary appearing.
 */
export const FirstMateRoundSummaryReceipt = Schema.Struct({
  type: Schema.Literal("firstmate.round-summary.settled"),
  threadId: ThreadId,
  turnId: TurnId,
  topicId: Schema.NullOr(FirstMateTopicId),
  outcome: Schema.Literals(["recorded", "skipped", "failed"]),
  createdAt: IsoDateTime,
});
export type FirstMateRoundSummaryReceipt = typeof FirstMateRoundSummaryReceipt.Type;

/**
 * One reconcile pass over a delegated thread's pending provider requests. The
 * counts are reported for every pass, including the ones that change nothing,
 * so a test can wait on the pass rather than on a card appearing.
 */
export const FirstMateRequestDecisionReceipt = Schema.Struct({
  type: Schema.Literal("firstmate.request-decision.settled"),
  threadId: ThreadId,
  openedCount: NonNegativeInt,
  cancelledCount: NonNegativeInt,
  outcome: Schema.Literals(["reconciled", "skipped", "failed"]),
  createdAt: IsoDateTime,
});
export type FirstMateRequestDecisionReceipt = typeof FirstMateRequestDecisionReceipt.Type;

export const OrchestrationRuntimeReceipt = Schema.Union([
  CheckpointBaselineCapturedReceipt,
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
  FirstMateRoundSummaryReceipt,
  FirstMateRequestDecisionReceipt,
]);
export type OrchestrationRuntimeReceipt = typeof OrchestrationRuntimeReceipt.Type;

export interface RuntimeReceiptBusShape {
  readonly publish: (receipt: OrchestrationRuntimeReceipt) => Effect.Effect<void>;
  readonly streamEventsForTest: Stream.Stream<OrchestrationRuntimeReceipt>;
}

export class RuntimeReceiptBus extends Context.Service<RuntimeReceiptBus, RuntimeReceiptBusShape>()(
  "t3/orchestration/Services/RuntimeReceiptBus",
) {}
