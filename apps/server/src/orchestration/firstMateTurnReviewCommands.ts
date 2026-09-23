/**
 * The two actions a FirstMate turn review can take on a worker thread, shared
 * by the reactor that acts on its own and the delivery reactor that acts on
 * the user's answer to a review card. `key` makes every id deterministic, so a
 * replayed trigger is the same command and the engine's receipt dedupe drops it.
 *
 * @module firstMateTurnReviewCommands
 */
import {
  CommandId,
  MessageId,
  ThreadQueuedMessageId,
  type OrchestrationCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { FIRST_MATE_CONTINUE_MESSAGE } from "@t3tools/shared/firstMateTurnReview";

/** Queue the fixed continue message behind whatever the thread is doing. */
export function turnReviewContinueCommand(input: {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly createdAt: string;
}): OrchestrationCommand {
  return {
    type: "thread.queued-message.enqueue",
    commandId: CommandId.make(`server:firstmate-turn-review-continue:${input.key}`),
    threadId: input.threadId,
    queuedMessageId: ThreadQueuedMessageId.make(`firstmate-turn-review-continue:${input.key}`),
    message: {
      messageId: MessageId.make(`firstmate-turn-review-continue:${input.key}`),
      role: "user",
      text: FIRST_MATE_CONTINUE_MESSAGE,
      attachments: [],
    },
    dispatchTiming: "after-current-turn",
    queuedAfterActivityId: null,
    createdAt: input.createdAt,
  };
}

/** Mark the thread's work done; the next user turn reopens it. */
export function turnReviewMarkDoneCommand(input: {
  readonly threadId: ThreadId;
  readonly key: string;
}): OrchestrationCommand {
  return {
    type: "thread.meta.update",
    commandId: CommandId.make(`server:firstmate-turn-review-done:${input.key}`),
    threadId: input.threadId,
    deliveryStatus: "done",
  };
}

/**
 * Prefix of every server-written report to the FirstMate supervisor. The
 * coordinator instructions (RuntimeInstructions.ts) tell the supervisor these
 * come from the server, and the turn review never reviews the supervisor, so
 * the reports neither get judged nor count as auto-continues.
 */
export const FIRST_MATE_THREAD_UPDATE_PREFIX = "[Thread update]";

const THREAD_UPDATE_QUESTION_CHARS = 300;
const THREAD_UPDATE_LAST_MESSAGE_CHARS = 500;

export type ThreadUpdateKind = "marked-done" | "needs-decision" | "blocked";

function clipTail(text: string, limit: number): string {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length <= limit ? line : `…${line.slice(-(limit - 1)).trimStart()}`;
}

/** One short report on a delegated thread's finished turn. */
export function buildThreadUpdateText(input: {
  readonly threadTitle: string;
  readonly topicTitle: string;
  readonly kind: ThreadUpdateKind;
  readonly lastAssistantText: string;
}): string {
  const tail = clipTail(input.lastAssistantText, THREAD_UPDATE_QUESTION_CHARS);
  const status =
    input.kind === "marked-done"
      ? "marked done"
      : input.kind === "blocked"
        ? `blocked: ${tail || "no message"}`
        : `needs your decision: ${tail || "no message"}`;
  const lastMessage = clipTail(input.lastAssistantText, THREAD_UPDATE_LAST_MESSAGE_CHARS);
  return `${FIRST_MATE_THREAD_UPDATE_PREFIX} ${input.threadTitle} (topic ${input.topicTitle}): ${status}.${
    lastMessage ? ` Last message: ${lastMessage}` : ""
  }`;
}

/** Queue a thread update for the supervisor behind whatever it is doing. */
export function threadUpdateCommand(input: {
  readonly supervisorThreadId: ThreadId;
  readonly key: string;
  readonly text: string;
  readonly createdAt: string;
}): OrchestrationCommand {
  return {
    type: "thread.queued-message.enqueue",
    commandId: CommandId.make(`server:firstmate-thread-update:${input.key}`),
    threadId: input.supervisorThreadId,
    queuedMessageId: ThreadQueuedMessageId.make(`firstmate-thread-update:${input.key}`),
    message: {
      messageId: MessageId.make(`firstmate-thread-update:${input.key}`),
      role: "user",
      text: input.text,
      attachments: [],
    },
    dispatchTiming: "after-current-turn",
    queuedAfterActivityId: null,
    createdAt: input.createdAt,
  };
}
