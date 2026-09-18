import {
  CommandId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ThreadId,
  type FirstMateDecisionOption,
  type FirstMateTopic,
  type FirstMateWorkspaceState,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  FirstMateCommandFailedError,
  FirstMateCommandRejectedError,
  FirstMateSupervisorOnlyError,
  FirstMateThreadNotFoundError,
  FirstMateToolkit,
  type FirstMateTopicResult,
} from "./tools.ts";

interface SupervisorScope {
  readonly thread: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly workspace: FirstMateWorkspaceState;
}

function topicResult(topic: {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly stage: FirstMateTopic["stage"];
  readonly threadId: string | null;
  readonly responsibleAgentId: string | null;
}): FirstMateTopicResult {
  return {
    topicId: topic.id,
    title: topic.title,
    summary: topic.summary,
    stage: topic.stage,
    threadId: topic.threadId,
    responsibleAgentId: topic.responsibleAgentId,
  };
}

/**
 * Adapter-level shape checks the decider does not own: it stores whatever
 * options it is given, but a decision card the user cannot choose between is
 * useless, so refuse it before it reaches the feed.
 */
function rejectUnusableDecision(
  options: ReadonlyArray<FirstMateDecisionOption>,
  recommendedOptionId: string | null,
): FirstMateCommandRejectedError | null {
  if (options.length < 2) {
    return new FirstMateCommandRejectedError({
      detail: "A decision needs at least two options for the user to choose between.",
    });
  }
  const ids = new Set(options.map((option) => option.id));
  if (ids.size !== options.length) {
    return new FirstMateCommandRejectedError({ detail: "Decision option ids must be unique." });
  }
  if (recommendedOptionId !== null && !ids.has(recommendedOptionId)) {
    return new FirstMateCommandRejectedError({
      detail: `recommendedOptionId ${recommendedOptionId} is not one of the options.`,
    });
  }
  return null;
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) => new FirstMateCommandFailedError({ cause })),
  );

  const commandId = (tag: string, threadId: ThreadId) =>
    uuid.pipe(Effect.map((value) => CommandId.make(`server:${tag}:${threadId}:${value}`)));

  /**
   * The gate for the whole toolkit. It reads the live workspace rather than a
   * capability stamped when the provider session started, so linking or
   * unlinking the supervisor takes effect without restarting the agent.
   */
  const requireSupervisor = Effect.fn("FirstMateToolkit.requireSupervisor")(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError((cause) => new FirstMateCommandFailedError({ cause })));
    if (Option.isNone(thread)) {
      return yield* new FirstMateThreadNotFoundError({ threadId: scope.threadId });
    }
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
      .pipe(Effect.mapError((cause) => new FirstMateCommandFailedError({ cause })));
    const workspace = Option.isNone(project) ? null : (project.value.firstMate ?? null);
    if (Option.isNone(project) || workspace === null) {
      return yield* new FirstMateSupervisorOnlyError({ threadId: scope.threadId });
    }
    if (workspace.supervisorThreadId !== thread.value.id) {
      return yield* new FirstMateSupervisorOnlyError({ threadId: scope.threadId });
    }
    return { thread: thread.value, project: project.value, workspace } satisfies SupervisorScope;
  });

  const requireTopic = Effect.fn("FirstMateToolkit.requireTopic")(function* (
    scope: SupervisorScope,
    topicId: string,
  ) {
    const topic = scope.workspace.topics.find((entry) => entry.id === topicId);
    if (topic === undefined) {
      return yield* new FirstMateCommandRejectedError({
        detail: `FirstMate topic ${topicId} was not found in this project.`,
      });
    }
    return topic;
  });

  const dispatchFailure = <E>(
    cause: Cause.Cause<E>,
  ): Effect.Effect<never, FirstMateCommandFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new FirstMateCommandFailedError({ cause }));

  /** The decider's rejection text is the most useful thing the agent can read. */
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.as(null),
      // The rejection becomes a value before catchCause runs, so an invariant
      // the agent can act on is not re-wrapped as an infrastructure failure.
      Effect.catchTags({
        OrchestrationCommandInvariantError: (error) => Effect.succeed(error.detail),
      }),
      Effect.catchCause(dispatchFailure),
      Effect.flatMap((detail) =>
        detail === null ? Effect.void : new FirstMateCommandRejectedError({ detail }),
      ),
    );

  return FirstMateToolkit.of({
    firstmate_create_topic: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireSupervisor();
        const topicId = FirstMateTopicId.make(`topic-${yield* uuid}`);
        const stage = input.stage ?? "research";
        const threadId = input.threadId == null ? null : ThreadId.make(input.threadId);
        const responsibleAgentId = input.responsibleAgentId ?? null;
        yield* dispatch({
          type: "firstmate.topic.create",
          commandId: yield* commandId("mcp-fm-topic-create", scope.thread.id),
          projectId: scope.project.id,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          topicId,
          title: input.title,
          summary: input.summary,
          stage,
          threadId,
          responsibleAgentId,
        });
        return topicResult({
          id: topicId,
          title: input.title,
          summary: input.summary,
          stage,
          threadId,
          responsibleAgentId,
        });
      }),

    firstmate_update_topic: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireSupervisor();
        const topic = yield* requireTopic(scope, input.topicId);
        if (input.title === undefined && input.summary === undefined && input.stage === undefined) {
          return yield* new FirstMateCommandRejectedError({
            detail: "Pass at least one of title, summary or stage.",
          });
        }
        yield* dispatch({
          type: "firstmate.topic.update",
          commandId: yield* commandId("mcp-fm-topic-update", scope.thread.id),
          projectId: scope.project.id,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          topicId: topic.id,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.stage === undefined ? {} : { stage: input.stage }),
        });
        return topicResult({
          ...topic,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.stage === undefined ? {} : { stage: input.stage }),
        });
      }),

    firstmate_delegate_topic: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireSupervisor();
        const topic = yield* requireTopic(scope, input.topicId);
        const threadId = input.threadId === null ? null : ThreadId.make(input.threadId);
        if (threadId !== null && threadId === scope.workspace.supervisorThreadId) {
          return yield* new FirstMateCommandRejectedError({
            detail: "A topic cannot be delegated to the supervisor thread itself.",
          });
        }
        const responsibleAgentId =
          input.responsibleAgentId === undefined
            ? topic.responsibleAgentId
            : input.responsibleAgentId;
        yield* dispatch({
          type: "firstmate.topic.delegate",
          commandId: yield* commandId("mcp-fm-topic-delegate", scope.thread.id),
          projectId: scope.project.id,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          topicId: topic.id,
          threadId,
          responsibleAgentId,
        });
        return topicResult({ ...topic, threadId, responsibleAgentId });
      }),

    firstmate_open_decision: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireSupervisor();
        const topic = yield* requireTopic(scope, input.topicId);
        const recommendedOptionId = input.recommendedOptionId ?? null;
        const unusable = rejectUnusableDecision(input.options, recommendedOptionId);
        if (unusable !== null) return yield* unusable;
        const decisionId = FirstMateDecisionId.make(`decision-${yield* uuid}`);
        yield* dispatch({
          type: "firstmate.decision.open",
          commandId: yield* commandId("mcp-fm-decision-open", scope.thread.id),
          projectId: scope.project.id,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          decisionId,
          topicId: topic.id,
          source: { kind: "firstmate", sourceId: scope.thread.id },
          question: input.question,
          options: input.options,
          recommendedOptionId,
          blocking: input.blocking,
        });
        return {
          decisionId,
          topicId: topic.id,
          question: input.question,
          optionIds: input.options.map((option) => option.id),
          blocking: input.blocking,
        };
      }),
  });
});

export const FirstMateToolkitHandlersLive = FirstMateToolkit.toLayer(make);
