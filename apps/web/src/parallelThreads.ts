import {
  type ComposerContextId,
  type OrchestrationMessage,
  type OrchestrationMessageContext,
  type OrchestrationProposedPlan,
  type ThreadId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";

const PARALLEL_CONTEXT_KIND = "parallel-thread" as const;
const MAX_PARALLEL_PAYLOAD_CHARS = 60_000;
const MAX_PARALLEL_MESSAGE_TEXT_CHARS = 16_000;
const MAX_PARALLEL_PLAN_CHARS = 20_000;
const MAX_PARALLEL_OBJECTIVE_CHARS = 8_000;

export interface ParallelThreadSourceSnapshot {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
  readonly sourceUpdatedAt: string;
  readonly forkedAt: string;
  readonly forkPointMessageId: string | null;
}

interface ParallelSourceMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly attachments?:
    | ReadonlyArray<{
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
      }>
    | undefined;
}

export function parseParallelThreadCommand(text: string): { objective: string | null } | null {
  const match = /^\/(?:paralelo|parallel)(?:\s+(.*))?$/is.exec(text.trim());
  if (!match) return null;
  const objective = match[1]?.trim();
  return { objective: objective ? objective : null };
}

function boundedText(value: string, maximum: number) {
  if (value.length <= maximum) return { text: value, truncated: false };
  return { text: value.slice(0, maximum), truncated: true };
}

function snapshotMessage(message: ParallelSourceMessage) {
  const bounded = boundedText(message.text, MAX_PARALLEL_MESSAGE_TEXT_CHARS);
  return {
    id: message.id,
    role: message.role,
    text: bounded.text,
    ...(bounded.truncated ? { textTruncated: true } : {}),
    ...(message.attachments && message.attachments.length > 0
      ? {
          attachments: message.attachments.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })),
        }
      : {}),
    createdAt: message.createdAt,
  };
}

export function buildParallelThreadStartMessage(input: {
  readonly contextId: ComposerContextId;
  readonly objective: string;
  readonly forkedAt: string;
  readonly sourceThread: {
    readonly id: ThreadId;
    readonly title: string;
    readonly updatedAt: string;
    readonly messages: ReadonlyArray<ParallelSourceMessage>;
  };
  readonly activePlan: OrchestrationProposedPlan | null;
}): { text: string; context: OrchestrationMessageContext } {
  const eligible = input.sourceThread.messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
  const selected: ReturnType<typeof snapshotMessage>[] = [];
  let omittedMessageCount = 0;
  const activePlan = input.activePlan
    ? {
        id: input.activePlan.id,
        ...boundedText(input.activePlan.planMarkdown, MAX_PARALLEL_PLAN_CHARS),
        updatedAt: input.activePlan.updatedAt,
      }
    : null;
  const objective = boundedText(input.objective, MAX_PARALLEL_OBJECTIVE_CHARS);
  const basePayload = {
    schemaVersion: 1,
    sourceThreadId: input.sourceThread.id,
    sourceThreadTitle: input.sourceThread.title,
    sourceUpdatedAt: input.sourceThread.updatedAt,
    forkedAt: input.forkedAt,
    forkPointMessageId: eligible.at(-1)?.id ?? null,
    objective: objective.text,
    ...(objective.truncated ? { objectiveTruncated: true } : {}),
    activePlan,
  };

  for (const message of eligible.toReversed()) {
    const candidate = snapshotMessage(message);
    const next = [candidate, ...selected];
    const length = JSON.stringify({ ...basePayload, omittedMessageCount, messages: next }).length;
    if (length <= MAX_PARALLEL_PAYLOAD_CHARS) {
      selected.unshift(candidate);
    } else {
      omittedMessageCount += 1;
    }
  }

  const payload = { ...basePayload, omittedMessageCount, messages: selected };
  const reference = formatComposerContextReference({
    kind: PARALLEL_CONTEXT_KIND,
    contextId: input.contextId,
    label: `Snapshot from ${input.sourceThread.title}`,
  });
  return {
    text: `${input.objective}\n\n${reference}`,
    context: {
      version: 1,
      records: [
        {
          version: 1,
          contextId: input.contextId,
          kind: PARALLEL_CONTEXT_KIND,
          label: `Snapshot from ${input.sourceThread.title}`,
          payload,
        },
      ],
    },
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Reads the durable source link from a parallel thread's loaded messages. */
export function readParallelThreadSourceSnapshot(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "context">>,
): ParallelThreadSourceSnapshot | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const record of message.context?.records ?? []) {
      if (record.kind !== PARALLEL_CONTEXT_KIND || !("payload" in record)) continue;
      const payload = record.payload;
      if (typeof payload !== "object" || payload === null) continue;
      const candidate = payload as Record<string, unknown>;
      if (
        candidate.schemaVersion !== 1 ||
        !isString(candidate.sourceThreadId) ||
        !isString(candidate.sourceThreadTitle) ||
        !isString(candidate.sourceUpdatedAt) ||
        !isString(candidate.forkedAt) ||
        !(candidate.forkPointMessageId === null || isString(candidate.forkPointMessageId))
      ) {
        continue;
      }
      return {
        sourceThreadId: candidate.sourceThreadId as ThreadId,
        sourceThreadTitle: candidate.sourceThreadTitle,
        sourceUpdatedAt: candidate.sourceUpdatedAt,
        forkedAt: candidate.forkedAt,
        forkPointMessageId: candidate.forkPointMessageId,
      };
    }
  }
  return null;
}

export function parallelThreadSnapshotIsStale(
  sourceUpdatedAt: string,
  currentSourceUpdatedAt: string,
): boolean {
  return currentSourceUpdatedAt !== sourceUpdatedAt;
}
