import {
  FirstMateDecisionOption,
  FirstMateTopicStage,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

/**
 * Every tool here is refused outside the project's FirstMate supervisor
 * thread. The toolkit is registered once for the whole MCP server, so each
 * description repeats the constraint instead of leaving the agent to discover
 * it from a failed call.
 */
const SUPERVISOR_ONLY =
  "Only works in the thread linked as this project's FirstMate supervisor; anywhere else it fails without changing anything.";

export class FirstMateSupervisorOnlyError extends Schema.TaggedError<FirstMateSupervisorOnlyError>()(
  "FirstMateSupervisorOnlyError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not this project's FirstMate supervisor thread. Ask the user to link it from the FirstMate panel before orchestrating topics.`;
  }
}

export class FirstMateThreadNotFoundError extends Schema.TaggedError<FirstMateThreadNotFoundError>()(
  "FirstMateThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

/** Carries the decider's own rejection text, which already names the invariant. */
export class FirstMateCommandRejectedError extends Schema.TaggedError<FirstMateCommandRejectedError>()(
  "FirstMateCommandRejectedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class FirstMateCommandFailedError extends Schema.TaggedError<FirstMateCommandFailedError>()(
  "FirstMateCommandFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not apply the FirstMate change.";
  }
}

export const FirstMateToolError = Schema.Union([
  FirstMateSupervisorOnlyError,
  FirstMateThreadNotFoundError,
  FirstMateCommandRejectedError,
  FirstMateCommandFailedError,
]);
export type FirstMateToolError = typeof FirstMateToolError.Type;

/** What every topic-shaped tool reports back, so the agent keeps the id it needs next. */
export const FirstMateTopicResult = Schema.Struct({
  topicId: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  stage: FirstMateTopicStage,
  threadId: Schema.NullOr(Schema.String),
  responsibleAgentId: Schema.NullOr(Schema.String),
});
export type FirstMateTopicResult = typeof FirstMateTopicResult.Type;

const CreateTopicTool = Tool.make("firstmate_create_topic", {
  description: `Open a FirstMate topic for one unit of work you intend to track and delegate. Use it when you split the user's request into parts, before delegating any of them; it returns the topicId the other FirstMate tools take. Do not create a topic for a question you can answer yourself. ${SUPERVISOR_ONLY}`,
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.annotate({
      description: "Short label the user sees in the FirstMate panel, such as Auth rate limits.",
    }),
    summary: TrimmedNonEmptyString.annotate({
      description:
        "One or two sentences on what this topic must achieve, written for the user rather than for the delegated agent.",
    }),
    stage: Schema.optional(
      FirstMateTopicStage.annotate({
        description: "Where the work currently stands. Defaults to research.",
      }),
    ),
    threadId: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString).annotate({
        description:
          "Thread that already owns this work, when one exists. Omit to create the topic undelegated and call firstmate_delegate_topic later.",
      }),
    ),
    responsibleAgentId: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString).annotate({
        description: "Agent or person accountable for the topic, shown beside it in the panel.",
      }),
    ),
  }),
  success: FirstMateTopicResult,
  failure: FirstMateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create FirstMate topic")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const UpdateTopicTool = Tool.make("firstmate_update_topic", {
  description: `Correct a FirstMate topic's title or summary, or move its stage as the work progresses. Call it when a delegated thread reports progress so the user's panel stops lying; pass only the fields that changed. ${SUPERVISOR_ONLY}`,
  parameters: Schema.Struct({
    topicId: TrimmedNonEmptyString.annotate({
      description: "Topic to change, as returned by firstmate_create_topic.",
    }),
    title: Schema.optional(TrimmedNonEmptyString),
    summary: Schema.optional(TrimmedNonEmptyString),
    stage: Schema.optional(
      FirstMateTopicStage.annotate({
        description: "New stage. Set completed only once the work is actually finished.",
      }),
    ),
  }),
  success: FirstMateTopicResult,
  failure: FirstMateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update FirstMate topic")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DelegateTopicTool = Tool.make("firstmate_delegate_topic", {
  description: `Point a FirstMate topic at the thread doing its work, so the user's messages about that topic route there. Call it once the worker thread exists. Pass threadId null to hand the topic back to no one. ${SUPERVISOR_ONLY}`,
  parameters: Schema.Struct({
    topicId: TrimmedNonEmptyString.annotate({ description: "Topic to delegate." }),
    threadId: Schema.NullOr(TrimmedNonEmptyString).annotate({
      description:
        "Thread that owns the work from now on, or null to undelegate. The supervisor thread itself is not a valid destination.",
    }),
    responsibleAgentId: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString).annotate({
        description: "Agent or person accountable for the topic. Omit to leave it unchanged.",
      }),
    ),
  }),
  success: FirstMateTopicResult,
  failure: FirstMateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate FirstMate topic to a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenDecisionResult = Schema.Struct({
  decisionId: Schema.String,
  topicId: Schema.String,
  question: Schema.String,
  optionIds: Schema.Array(Schema.String),
  blocking: Schema.Boolean,
});
export type OpenDecisionResult = typeof OpenDecisionResult.Type;

const OpenDecisionTool = Tool.make("firstmate_open_decision", {
  description: `Put a decision in front of the user as a card in the FirstMate chat: one question, at least two concrete options, and your recommendation. Use it instead of asking in prose whenever the answer changes what a topic does. Set blocking when the topic cannot continue until they answer. The answer does not come back from this call; the user resolves the card and the resolved option becomes part of the topic's history. ${SUPERVISOR_ONLY}`,
  parameters: Schema.Struct({
    topicId: TrimmedNonEmptyString.annotate({
      description: "Topic this decision belongs to.",
    }),
    question: TrimmedNonEmptyString.annotate({
      description:
        "The decision, phrased so the user can answer it without reading the thread. State the tradeoff, not the implementation detail.",
    }),
    options: Schema.Array(FirstMateDecisionOption).annotate({
      description:
        "At least two mutually exclusive options. Each needs a stable id, a short label, and a description of what choosing it means.",
    }),
    recommendedOptionId: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString).annotate({
        description:
          "Id of the option you would pick. Must be one of the options. Omit only when you genuinely have no preference.",
      }),
    ),
    blocking: Schema.Boolean.annotate({
      description:
        "True when the topic is stalled until the user answers; blocking decisions sort to the top of the feed.",
    }),
  }),
  success: OpenDecisionResult,
  failure: FirstMateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Open FirstMate decision for the user")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/**
 * A workspace accumulates topics forever, so the listing is bounded: completed
 * topics are history rather than orientation and are omitted unless asked for
 * by stage, and the rest are capped newest-first.
 */
export const FIRST_MATE_TOPIC_LIST_LIMIT = 50;

export const FirstMateTopicListEntry = Schema.Struct({
  ...FirstMateTopicResult.fields,
  pendingDecisionCount: Schema.Int,
  lastRoundSummary: Schema.NullOr(Schema.String).annotate({
    description:
      "What the delegated thread's last finished round produced, written by the summary model. Null until a round finishes, and never a substitute for summary, which is what the topic must achieve.",
  }),
});
export type FirstMateTopicListEntry = typeof FirstMateTopicListEntry.Type;

/** Deliberately without option text: this only has to stop a duplicate question. */
export const FirstMatePendingDecisionEntry = Schema.Struct({
  decisionId: Schema.String,
  /** Null for a card lifted from a thread no topic is delegated to. */
  topicId: Schema.NullOr(Schema.String),
  question: Schema.String,
  blocking: Schema.Boolean,
});
export type FirstMatePendingDecisionEntry = typeof FirstMatePendingDecisionEntry.Type;

export const ListTopicsResult = Schema.Struct({
  selectedTopicId: Schema.NullOr(Schema.String).annotate({
    description:
      "Topic the user's next supervisor message routes to, or null when they will be asked to pick one. Reported even when that topic is filtered out of topics below.",
  }),
  topics: Schema.Array(FirstMateTopicListEntry),
  pendingDecisions: Schema.Array(FirstMatePendingDecisionEntry),
  truncated: Schema.Boolean.annotate({
    description: "True when older topics were dropped to bound the response.",
  }),
});
export type ListTopicsResult = typeof ListTopicsResult.Type;

const ListTopicsTool = Tool.make("firstmate_list_topics", {
  description: `Read this project's FirstMate topics with the id each other FirstMate tool takes, plus the questions already waiting on the user. Call it when you have lost track of the topic ids, when resuming a conversation, or before opening a decision, so you extend existing topics and do not ask the user something they are already being asked. Completed topics are omitted unless you pass stage. ${SUPERVISOR_ONLY}`,
  parameters: Schema.Struct({
    stage: Schema.optional(
      FirstMateTopicStage.annotate({
        description:
          "Return only topics at this stage. Omit for every topic that is not completed.",
      }),
    ),
  }),
  success: ListTopicsResult,
  failure: FirstMateToolError,
  dependencies,
})
  .annotate(Tool.Title, "List FirstMate topics")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SendToTopicResult = Schema.Struct({
  topicId: Schema.String,
  threadId: Schema.String,
  queuedMessageId: Schema.String,
});
export type SendToTopicResult = typeof SendToTopicResult.Type;

const SendToTopicTool = Tool.make("firstmate_send_to_topic", {
  description: `Queue a message for the thread a FirstMate topic is delegated to, so the agent working on that topic reads it at its next turn boundary. Use it to hand a delegated topic new instructions, an answer the user gave you, or a correction. The destination comes from the topic's delegation, so delegate the topic first; you cannot name a thread yourself. The call returns once the message is queued and never waits for a reply. ${SUPERVISOR_ONLY}`,
  parameters: Schema.Struct({
    topicId: TrimmedNonEmptyString.annotate({
      description: "Topic whose delegated thread receives the message.",
    }),
    text: TrimmedNonEmptyString.annotate({
      description:
        "What the delegated agent should read, written for that agent rather than for the user.",
    }),
  }),
  success: SendToTopicResult,
  failure: FirstMateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send a message to a FirstMate topic's thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const FIRST_MATE_THREAD_LIST_LIMIT = 50;

export const FirstMateProjectThreadEntry = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  /** Whether a provider session is mid-turn, so delegation lands behind it. */
  running: Schema.Boolean,
  waitingOnUser: Schema.Boolean,
  delegatedToTopicId: Schema.NullOr(Schema.String).annotate({
    description: "Topic that already owns this thread. Delegating it again would move that work.",
  }),
  updatedAt: Schema.String,
});
export type FirstMateProjectThreadEntry = typeof FirstMateProjectThreadEntry.Type;

export const ListProjectThreadsResult = Schema.Struct({
  threads: Schema.Array(FirstMateProjectThreadEntry),
  truncated: Schema.Boolean.annotate({
    description: "True when older threads were dropped to bound the response.",
  }),
});
export type ListProjectThreadsResult = typeof ListProjectThreadsResult.Type;

const ListProjectThreadsTool = Tool.make("firstmate_list_project_threads", {
  description: `Read this project's unsettled threads with the id firstmate_delegate_topic takes. Without it a topic can only be delegated to a thread id the user typed out, so call it before delegating or when asked what work is open. Settled, archived, and deleted threads are omitted. ${SUPERVISOR_ONLY}`,
  parameters: Schema.Struct({
    includeDelegated: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Include threads another topic already owns. Omit to see only threads free to take.",
      }),
    ),
  }),
  success: ListProjectThreadsResult,
  failure: FirstMateToolError,
  dependencies,
})
  .annotate(Tool.Title, "List project threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const FirstMateToolkit = Toolkit.make(
  CreateTopicTool,
  UpdateTopicTool,
  DelegateTopicTool,
  OpenDecisionTool,
  ListTopicsTool,
  ListProjectThreadsTool,
  SendToTopicTool,
);
