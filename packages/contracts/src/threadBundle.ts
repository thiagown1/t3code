import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInteractionMode, RuntimeMode, OrchestrationMessageRole } from "./orchestration.ts";

const StableReference = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const ThreadBundleProjectReference = Schema.Struct({
  sourceProjectId: ProjectId,
  title: TrimmedNonEmptyString,
  repositoryCanonicalKey: Schema.optionalKey(StableReference),
  repositoryProvider: Schema.optionalKey(StableReference),
  repositoryOwner: Schema.optionalKey(StableReference),
  repositoryName: Schema.optionalKey(StableReference),
});
export type ThreadBundleProjectReference = typeof ThreadBundleProjectReference.Type;

/**
 * An attachment is portable metadata only. The content must be exported by a
 * separate, integrity-checked asset adapter before it can be restored.
 */
export const ThreadBundleAttachmentReference = Schema.Struct({
  sourceAttachmentId: StableReference,
  type: StableReference,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
  availability: Schema.Literal("reference-only"),
});
export type ThreadBundleAttachmentReference = typeof ThreadBundleAttachmentReference.Type;

export const ThreadBundleMessage = Schema.Struct({
  sourceMessageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.Array(ThreadBundleAttachmentReference),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadBundleMessage = typeof ThreadBundleMessage.Type;

export const ThreadBundleProposedPlan = Schema.Struct({
  sourcePlanId: StableReference,
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadBundleProposedPlan = typeof ThreadBundleProposedPlan.Type;

export const ThreadBundleResolvedDecision = Schema.Struct({
  sourceDecisionId: StableReference,
  question: TrimmedNonEmptyString,
  options: Schema.Array(
    Schema.Struct({
      id: StableReference,
      label: TrimmedNonEmptyString,
      description: TrimmedNonEmptyString,
    }),
  ),
  recommendedOptionId: Schema.NullOr(StableReference),
  selectedOptionId: StableReference,
  blocking: Schema.Boolean,
  resolvedAt: IsoDateTime,
});
export type ThreadBundleResolvedDecision = typeof ThreadBundleResolvedDecision.Type;

export const ThreadBundleOmissionKind = Schema.Literals([
  "active-streaming-message",
  "message-context",
  "attachment-content",
  "attachment-source",
  "activity",
  "checkpoint",
  "session",
  "pending-decision",
  "cancelled-decision",
  "worktree-path",
]);
export type ThreadBundleOmissionKind = typeof ThreadBundleOmissionKind.Type;

export const ThreadBundleOmission = Schema.Struct({
  kind: ThreadBundleOmissionKind,
  count: NonNegativeInt,
});
export type ThreadBundleOmission = typeof ThreadBundleOmission.Type;

export const ThreadBundleThread = Schema.Struct({
  sourceEnvironmentId: StableReference,
  sourceThreadId: ThreadId,
  project: ThreadBundleProjectReference,
  title: TrimmedNonEmptyString,
  preferredModel: Schema.Struct({
    providerInstanceRef: StableReference,
    model: TrimmedNonEmptyString,
  }),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(ThreadBundleMessage),
  proposedPlans: Schema.Array(ThreadBundleProposedPlan),
  resolvedDecisions: Schema.Array(ThreadBundleResolvedDecision),
  omissions: Schema.Array(ThreadBundleOmission),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadBundleThread = typeof ThreadBundleThread.Type;

/**
 * Portable conversation data only. Runtime sessions, approvals, locks,
 * credentials, filesystem paths, cookies, tokens, and process state have no
 * representation in this schema.
 */
export const ThreadBundle = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  bundleId: StableReference,
  exportedAt: IsoDateTime,
  threads: Schema.Array(ThreadBundleThread),
});
export type ThreadBundle = typeof ThreadBundle.Type;
