import {
  FirstMateDecisionId,
  FirstMateTopicId,
  MessageId,
  ProviderInstanceId,
  type CommandId,
  type OrchestrationCommand,
  type OrchestrationProposedPlanId,
  type ThreadBundle,
  type ThreadBundleImportPlan,
} from "@t3tools/contracts";
import { normalizeThreadBundle, threadBundleTargetThreadId } from "@t3tools/shared/threadBundle";

import {
  threadBundleAttachmentMessageKey,
  type PreparedThreadBundleAttachments,
} from "./ThreadBundleAttachmentStore.ts";

type ThreadBundleImportCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.bundle.import" }
>;

function scopedId(prefix: string, ...parts: ReadonlyArray<string>): string {
  return [prefix, ...parts.map(encodeURIComponent)].join(":");
}

function originKey(sourceEnvironmentId: string, sourceThreadId: string): string {
  return `${sourceEnvironmentId}:${sourceThreadId}`;
}

export function threadBundleImportPlansMatch(
  expected: ThreadBundleImportPlan,
  current: ThreadBundleImportPlan,
): boolean {
  return JSON.stringify(expected) === JSON.stringify(current);
}

export function buildThreadBundleImportCommand(input: {
  readonly bundle: ThreadBundle;
  readonly plan: ThreadBundleImportPlan;
  readonly commandId: CommandId;
  readonly preparedAttachments?: PreparedThreadBundleAttachments;
}): ThreadBundleImportCommand {
  if (!input.plan.canImport || input.plan.bundleId !== input.bundle.bundleId) {
    throw new Error("Thread Bundle import plan is not ready for this bundle");
  }
  const normalized = normalizeThreadBundle(input.bundle);
  const plannedByOrigin = new Map(
    input.plan.items.map((item) => [
      originKey(item.sourceEnvironmentId, item.sourceThreadId),
      item,
    ]),
  );
  if (plannedByOrigin.size !== normalized.threads.length) {
    throw new Error("Thread Bundle import plan does not cover every source thread");
  }

  const entries: ThreadBundleImportCommand["entries"] = normalized.threads.map((thread) => {
    const planned = plannedByOrigin.get(
      originKey(thread.sourceEnvironmentId, thread.sourceThreadId),
    );
    const expectedTargetThreadId = threadBundleTargetThreadId(thread);
    if (
      !planned ||
      planned.status !== "ready" ||
      planned.targetProjectId === null ||
      planned.targetThreadId !== expectedTargetThreadId
    ) {
      throw new Error("Thread Bundle import plan contains a stale or blocked thread");
    }
    const topicId = FirstMateTopicId.make(
      scopedId("bundle-topic", thread.sourceEnvironmentId, thread.sourceThreadId),
    );
    return {
      sourceEnvironmentId: thread.sourceEnvironmentId,
      sourceThreadId: thread.sourceThreadId,
      targetThreadId: planned.targetThreadId,
      projectId: planned.targetProjectId,
      title: thread.title,
      modelSelection: {
        instanceId: ProviderInstanceId.make(thread.preferredModel.providerInstanceRef),
        model: thread.preferredModel.model,
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      messages: thread.messages.map((message) => {
        const attachments = input.preparedAttachments?.attachmentsByMessage.get(
          threadBundleAttachmentMessageKey({
            sourceEnvironmentId: thread.sourceEnvironmentId,
            sourceThreadId: thread.sourceThreadId,
            sourceMessageId: message.sourceMessageId,
          }),
        );
        if (normalized.schemaVersion === 2 && attachments === undefined) {
          throw new Error("Thread Bundle attachments were not prepared for import");
        }
        return {
          messageId: MessageId.make(
            scopedId(
              "bundle-message",
              thread.sourceEnvironmentId,
              thread.sourceThreadId,
              message.sourceMessageId,
            ),
          ),
          role: message.role,
          text: message.text,
          ...(attachments !== undefined ? { attachments } : {}),
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        };
      }),
      proposedPlans: thread.proposedPlans.map((plan) => ({
        id: scopedId(
          "bundle-plan",
          thread.sourceEnvironmentId,
          thread.sourceThreadId,
          plan.sourcePlanId,
        ) as OrchestrationProposedPlanId,
        turnId: null,
        planMarkdown: plan.planMarkdown,
        implementedAt: plan.implementedAt,
        implementationThreadId: null,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      })),
      resolvedDecisions: thread.resolvedDecisions.map((decision) => ({
        topicId,
        decisionId: FirstMateDecisionId.make(
          scopedId(
            "bundle-decision",
            thread.sourceEnvironmentId,
            thread.sourceThreadId,
            decision.sourceDecisionId,
          ),
        ),
        sourceId: scopedId(
          "thread-bundle",
          thread.sourceEnvironmentId,
          thread.sourceThreadId,
          decision.sourceDecisionId,
        ),
        question: decision.question,
        options: decision.options,
        recommendedOptionId: decision.recommendedOptionId,
        selectedOptionId: decision.selectedOptionId,
        blocking: decision.blocking,
        resolvedAt: decision.resolvedAt,
      })),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  });
  const finalEntry = entries.at(-1);
  if (!finalEntry) throw new Error("Thread Bundle import requires at least one thread");
  return {
    type: "thread.bundle.import",
    commandId: input.commandId,
    threadId: finalEntry.targetThreadId,
    entries,
  };
}
