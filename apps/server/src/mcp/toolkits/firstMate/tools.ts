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

export const FirstMateToolkit = Toolkit.make(
  CreateTopicTool,
  UpdateTopicTool,
  DelegateTopicTool,
  OpenDecisionTool,
);
