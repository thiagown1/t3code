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
