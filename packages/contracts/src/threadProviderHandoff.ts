import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { OrchestrationMessageRole, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const StableReference = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const ContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const THREAD_PROVIDER_HANDOFF_SCHEMA_VERSION = 1 as const;
export const THREAD_PROVIDER_HANDOFF_MAX_MESSAGES = 200;
export const THREAD_PROVIDER_HANDOFF_MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const THREAD_PROVIDER_HANDOFF_MAX_MESSAGE_CHARS = 32_000;
export const THREAD_PROVIDER_HANDOFF_MAX_CONTEXT_BYTES = 1_000_000;
export const THREAD_PROVIDER_HANDOFF_MAX_PLANS = 50;
export const THREAD_PROVIDER_HANDOFF_MAX_PLAN_CHARS = 100_000;
export const THREAD_PROVIDER_HANDOFF_MAX_DECISIONS = 100;
export const THREAD_PROVIDER_HANDOFF_MAX_OMISSION_KINDS = 32;

export const ThreadProviderHandoffReason = Schema.Literals(["quota", "user", "context"]);
export type ThreadProviderHandoffReason = typeof ThreadProviderHandoffReason.Type;

export const ThreadProviderHandoffState = Schema.Literals([
  "requested",
  "validating",
  "compacting",
  "prepared",
  "target-starting",
  "target-ready",
  "committing",
  "committed",
  "failed",
  "cancelled",
  "unknown",
]);
export type ThreadProviderHandoffState = typeof ThreadProviderHandoffState.Type;

export const ThreadProviderHandoffProvider = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type ThreadProviderHandoffProvider = typeof ThreadProviderHandoffProvider.Type;

export const ThreadProviderHandoffStartInput = Schema.Struct({
  threadId: ThreadId,
  target: ThreadProviderHandoffProvider,
});
export type ThreadProviderHandoffStartInput = typeof ThreadProviderHandoffStartInput.Type;

export const ThreadProviderHandoffStartResult = Schema.Struct({
  handoffId: TrimmedNonEmptyString,
  state: Schema.Literal("committed"),
  omissions: Schema.Array(Schema.Struct({ kind: TrimmedNonEmptyString, count: NonNegativeInt })),
});
export type ThreadProviderHandoffStartResult = typeof ThreadProviderHandoffStartResult.Type;

export class ThreadProviderHandoffRpcError extends Schema.TaggedError<ThreadProviderHandoffRpcError>()(
  "ThreadProviderHandoffRpcError",
  {
    code: Schema.Literals(["preflight", "target", "commit", "unknown"]),
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ThreadProviderHandoffAttachment = Schema.Struct({
  sourceAttachmentId: StableReference,
  type: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
  availability: Schema.Literal("reference-only"),
});
export type ThreadProviderHandoffAttachment = typeof ThreadProviderHandoffAttachment.Type;

export const ThreadProviderHandoffMessage = Schema.Struct({
  sourceMessageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String.check(Schema.isMaxLength(THREAD_PROVIDER_HANDOFF_MAX_MESSAGE_CHARS)),
  attachments: Schema.Array(ThreadProviderHandoffAttachment).check(
    Schema.isMaxLength(THREAD_PROVIDER_HANDOFF_MAX_ATTACHMENTS_PER_MESSAGE),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadProviderHandoffMessage = typeof ThreadProviderHandoffMessage.Type;

export const ThreadProviderHandoffPlan = Schema.Struct({
  sourcePlanId: StableReference,
  planMarkdown: TrimmedNonEmptyString.check(
    Schema.isMaxLength(THREAD_PROVIDER_HANDOFF_MAX_PLAN_CHARS),
  ),
  implementedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadProviderHandoffPlan = typeof ThreadProviderHandoffPlan.Type;

// Resolved choices are portable; the original question and approval payload are not.
export const ThreadProviderHandoffDecision = Schema.Struct({
  sourceDecisionId: StableReference,
  selectedOptionId: StableReference,
  resolvedAt: IsoDateTime,
});
export type ThreadProviderHandoffDecision = typeof ThreadProviderHandoffDecision.Type;

export const ThreadProviderHandoffOmissionKind = Schema.Literals([
  "streaming-message",
  "incomplete-message",
  "sensitive-content",
  "message-context",
  "tool-payload",
  "approval",
  "question",
  "attachment-content",
  "attachment-source",
  "absolute-path",
  "unvalidated-attachment",
  "invalid-message",
  "invalid-plan",
  "invalid-decision",
]);
export type ThreadProviderHandoffOmissionKind = typeof ThreadProviderHandoffOmissionKind.Type;

export const ThreadProviderHandoffOmission = Schema.Struct({
  kind: ThreadProviderHandoffOmissionKind,
  count: NonNegativeInt,
});
export type ThreadProviderHandoffOmission = typeof ThreadProviderHandoffOmission.Type;

const ThreadProviderHandoffOmissions = Schema.Array(ThreadProviderHandoffOmission).check(
  Schema.isMaxLength(THREAD_PROVIDER_HANDOFF_MAX_OMISSION_KINDS),
);

export const ThreadProviderHandoffContext = Schema.Struct({
  projectId: ProjectId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  messages: Schema.Array(ThreadProviderHandoffMessage).check(
    Schema.isMaxLength(THREAD_PROVIDER_HANDOFF_MAX_MESSAGES),
  ),
  proposedPlans: Schema.Array(ThreadProviderHandoffPlan).check(
    Schema.isMaxLength(THREAD_PROVIDER_HANDOFF_MAX_PLANS),
  ),
  resolvedDecisions: Schema.Array(ThreadProviderHandoffDecision).check(
    Schema.isMaxLength(THREAD_PROVIDER_HANDOFF_MAX_DECISIONS),
  ),
});
export type ThreadProviderHandoffContext = typeof ThreadProviderHandoffContext.Type;

const ThreadProviderHandoffIdentity = {
  schemaVersion: Schema.Literal(THREAD_PROVIDER_HANDOFF_SCHEMA_VERSION),
  handoffId: StableReference,
  threadId: ThreadId,
  source: ThreadProviderHandoffProvider,
  target: ThreadProviderHandoffProvider,
  reason: ThreadProviderHandoffReason,
  sequence: NonNegativeInt,
  sourceTurnId: Schema.optionalKey(TurnId),
} as const;

/** Durable lifecycle metadata. Conversation content never belongs in this record. */
export const ThreadProviderHandoffRecord = Schema.Struct({
  ...ThreadProviderHandoffIdentity,
  state: ThreadProviderHandoffState,
  contextHash: Schema.optionalKey(ContentHash),
  envelopeHash: Schema.optionalKey(ContentHash),
  errorCode: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  omissions: Schema.optionalKey(ThreadProviderHandoffOmissions),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadProviderHandoffRecord = typeof ThreadProviderHandoffRecord.Type;

/** Sanitized portable payload. `envelopeHash` hashes every other envelope field. */
export const ThreadProviderHandoffEnvelope = Schema.Struct({
  ...ThreadProviderHandoffIdentity,
  contextHash: ContentHash,
  envelopeHash: ContentHash,
  contextBytes: NonNegativeInt,
  omissions: ThreadProviderHandoffOmissions,
  context: ThreadProviderHandoffContext,
  createdAt: IsoDateTime,
});
export type ThreadProviderHandoffEnvelope = typeof ThreadProviderHandoffEnvelope.Type;
