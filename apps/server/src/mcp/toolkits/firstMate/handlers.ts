import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  FirstMateDecisionId,
  FirstMateTopicId,
  MessageId,
  ThreadId,
  ThreadQueuedMessageId,
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
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  FIRST_MATE_THREAD_LIST_LIMIT,
  FIRST_MATE_TOPIC_LIST_LIMIT,
  FirstMateCommandFailedError,
  FirstMateCommandRejectedError,
  FirstMateSupervisorOnlyError,
  FirstMateThreadNotFoundError,
  FirstMateToolkit,
  type FirstMateTopicResult,
  type ListTopicsResult,
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
 * Newest work first, so the cap drops the stalest topics rather than an
 * arbitrary slice. Pending decisions stay unfiltered by stage: the point of
 * reporting them is to stop the supervisor asking a question that is already
 * in front of the user, and that holds whatever stage its topic is at.
 */
function listTopics(
  workspace: FirstMateWorkspaceState,
  stage: FirstMateTopic["stage"] | undefined,
): ListTopicsResult {
  // Blocking first, so the cap below drops advisory questions rather than the
  // ones stalling a topic, and the order matches the user's decision feed.
  const pending = workspace.decisions
    .filter((decision) => decision.status === "pending")
    .toSorted((left, right) => Number(right.blocking) - Number(left.blocking));
  const pendingCountByTopic = new Map<string, number>();
  for (const decision of pending) {
    // A card lifted from a thread with no topic still reaches the supervisor
    // through `pendingDecisions`; it just has no topic row to count against.
    if (decision.topicId === null) continue;
    pendingCountByTopic.set(decision.topicId, (pendingCountByTopic.get(decision.topicId) ?? 0) + 1);
  }
  const matching = workspace.topics
    .filter((topic) => (stage === undefined ? topic.stage !== "completed" : topic.stage === stage))
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    // Independent of the stage filter and the cap: where the user's next
    // message lands is not something the supervisor may be blind to.
    selectedTopicId: workspace.selectedTopicId,
    topics: matching.slice(0, FIRST_MATE_TOPIC_LIST_LIMIT).map((topic) => ({
      ...topicResult(topic),
      pendingDecisionCount: pendingCountByTopic.get(topic.id) ?? 0,
      lastRoundSummary: topic.latestRoundSummary?.text ?? null,
    })),
    pendingDecisions: pending.slice(0, FIRST_MATE_TOPIC_LIST_LIMIT).map((decision) => ({
      decisionId: decision.id,
      topicId: decision.topicId,
      question: decision.question,
      blocking: decision.blocking,
    })),
    truncated:
      matching.length > FIRST_MATE_TOPIC_LIST_LIMIT || pending.length > FIRST_MATE_TOPIC_LIST_LIMIT,
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

const DISPATCH_SUMMARY_MAX_CHARS = 240;

/** A dispatched topic's summary: the prompt on one line, cut to panel size. */
function summarizePrompt(prompt: string): string {
  const line = prompt.replaceAll(/\s+/g, " ").trim();
  return line.length <= DISPATCH_SUMMARY_MAX_CHARS
    ? line
    : `${line.slice(0, DISPATCH_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

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

  /**
   * Where a message for a topic is allowed to land.
   *
   * The destination is always the topic's own delegation, so a supervisor can
   * only reach threads the user's topics already point at, never an arbitrary
   * thread it names. Every way the lookup can come up short is a refusal:
   * `getThreadShellById` returns nothing for a deleted or archived thread, and
   * guessing a neighbour would put the supervisor's instructions in front of
   * the wrong agent.
   */
  const requireDelegatedThread = Effect.fn("FirstMateToolkit.requireDelegatedThread")(function* (
    scope: SupervisorScope,
    topic: FirstMateTopic,
  ) {
    if (topic.threadId === null) {
      return yield* new FirstMateCommandRejectedError({
        detail: `FirstMate topic ${topic.id} has no delegated thread. Call firstmate_delegate_topic before sending to it.`,
      });
    }
    if (topic.threadId === scope.workspace.supervisorThreadId) {
      return yield* new FirstMateCommandRejectedError({
        detail: `FirstMate topic ${topic.id} is delegated to the supervisor thread itself, which cannot be sent to.`,
      });
    }
    const thread = yield* snapshots
      .getThreadShellById(topic.threadId)
      .pipe(Effect.mapError((cause) => new FirstMateCommandFailedError({ cause })));
    if (Option.isNone(thread)) {
      return yield* new FirstMateCommandRejectedError({
        detail: `Thread ${topic.threadId} delegated to FirstMate topic ${topic.id} is archived or no longer exists. Delegate the topic to a live thread first.`,
      });
    }
    if (thread.value.projectId !== scope.project.id) {
      return yield* new FirstMateCommandRejectedError({
        detail: `Thread ${topic.threadId} delegated to FirstMate topic ${topic.id} belongs to another project.`,
      });
    }
    return thread.value;
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

  /**
   * The worktree half of the client's new-thread bootstrap (see
   * dispatchBootstrapTurnStart in ws.ts), without the progress card or setup
   * script: branch off the project's checked-out ref into a temporary branch.
   * Null means the project cannot host a worktree and the thread runs local.
   */
  const prepareWorktree = Effect.fn("FirstMateToolkit.prepareWorktree")(function* (
    projectCwd: string,
  ) {
    const status = yield* gitWorkflow
      .localStatus({ cwd: projectCwd })
      .pipe(Effect.mapError((cause) => new FirstMateCommandFailedError({ cause })));
    if (!status.isRepo || status.refName === null) return null;
    const token = (yield* uuid).replaceAll("-", "");
    const created = yield* gitWorkflow
      .createWorktree({
        cwd: projectCwd,
        refName: status.refName,
        newRefName: buildTemporaryWorktreeBranchName(() => token),
        baseRefName: status.refName,
        path: null,
      })
      .pipe(Effect.mapError((cause) => new FirstMateCommandFailedError({ cause })));
    return { branch: created.worktree.refName, worktreePath: created.worktree.path };
  });

  return FirstMateToolkit.of({
    firstmate_dispatch: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireSupervisor();
        const existingTopic =
          input.topicId === undefined ? null : yield* requireTopic(scope, input.topicId);
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((cause) => new FirstMateCommandFailedError({ cause })),
        );
        const projectSettings = resolveProjectSettings(
          settings,
          scope.project.id,
          scope.project,
        ).settings;
        // Same resolution as a new thread from the sidebar; the supervisor's
        // own model is only the last resort.
        const modelSelection =
          input.modelSelection ??
          projectSettings.defaultModelSelection ??
          scope.thread.modelSelection;
        const runtimeMode = projectSettings.defaultRuntimeMode;
        const worktree =
          (input.isolation ?? "worktree") === "worktree"
            ? yield* prepareWorktree(scope.project.workspaceRoot)
            : null;
        const threadId = ThreadId.make(yield* uuid);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* dispatch({
          type: "thread.create",
          commandId: yield* commandId("mcp-fm-dispatch-thread", scope.thread.id),
          threadId,
          projectId: scope.project.id,
          title: input.title,
          modelSelection,
          runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: worktree?.branch ?? null,
          worktreePath: worktree?.worktreePath ?? null,
          createdAt,
        });
        // Delegate before the turn starts so its first finished turn already
        // reports back to the supervisor.
        let topicId: FirstMateTopicId;
        if (existingTopic === null) {
          topicId = FirstMateTopicId.make(`topic-${yield* uuid}`);
          yield* dispatch({
            type: "firstmate.topic.create",
            commandId: yield* commandId("mcp-fm-dispatch-topic", scope.thread.id),
            projectId: scope.project.id,
            createdAt,
            topicId,
            title: input.title,
            summary: summarizePrompt(input.prompt),
            stage: "implementation",
            threadId,
            responsibleAgentId: null,
          });
        } else {
          topicId = existingTopic.id;
          yield* dispatch({
            type: "firstmate.topic.delegate",
            commandId: yield* commandId("mcp-fm-dispatch-delegate", scope.thread.id),
            projectId: scope.project.id,
            createdAt,
            topicId,
            threadId,
            responsibleAgentId: existingTopic.responsibleAgentId,
          });
        }
        yield* dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("mcp-fm-dispatch-turn", scope.thread.id),
          threadId,
          message: {
            messageId: MessageId.make(`firstmate-dispatch:${yield* uuid}`),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        });
        return {
          threadId,
          topicId,
          isolation: worktree === null ? ("local" as const) : ("worktree" as const),
          branch: worktree?.branch ?? null,
        };
      }),

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

    firstmate_list_topics: (input) =>
      requireSupervisor().pipe(Effect.map((scope) => listTopics(scope.workspace, input.stage))),

    firstmate_list_project_threads: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireSupervisor();
        const snapshot = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError((cause) => new FirstMateCommandFailedError({ cause })));
        const topicByThreadId = new Map(
          scope.workspace.topics
            .filter((topic) => topic.threadId !== null)
            .map((topic) => [topic.threadId as string, topic.id]),
        );
        const candidates = snapshot.threads
          .filter(
            (thread) =>
              thread.projectId === scope.project.id &&
              thread.id !== scope.thread.id &&
              thread.archivedAt === null &&
              thread.settledOverride !== "settled",
          )
          .filter(
            (thread) =>
              input.includeDelegated === true || !topicByThreadId.has(thread.id as string),
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return {
          threads: candidates.slice(0, FIRST_MATE_THREAD_LIST_LIMIT).map((thread) => ({
            threadId: thread.id as string,
            title: thread.title,
            branch: thread.branch,
            running: thread.session?.status === "running" || thread.session?.status === "starting",
            waitingOnUser: thread.hasPendingUserInput || thread.hasPendingApprovals,
            delegatedToTopicId: topicByThreadId.get(thread.id as string) ?? null,
            updatedAt: thread.updatedAt,
          })),
          truncated: candidates.length > FIRST_MATE_THREAD_LIST_LIMIT,
        };
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

    firstmate_send_to_topic: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireSupervisor();
        const topic = yield* requireTopic(scope, input.topicId);
        const destination = yield* requireDelegatedThread(scope, topic);
        const queuedMessageId = ThreadQueuedMessageId.make(`firstmate-topic:${yield* uuid}`);
        yield* dispatch({
          type: "thread.queued-message.enqueue",
          commandId: yield* commandId("mcp-fm-topic-send", scope.thread.id),
          threadId: destination.id,
          queuedMessageId,
          message: {
            messageId: MessageId.make(`firstmate-topic:${yield* uuid}`),
            role: "user",
            text: input.text,
            attachments: [],
          },
          // A supervisor instruction is never an interrupt. On an idle thread
          // the queue releases it immediately; mid-turn it waits for the turn
          // rather than cutting into the worker's current thought.
          dispatchTiming: "after-current-turn",
          queuedAfterActivityId: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        return { topicId: topic.id, threadId: destination.id, queuedMessageId };
      }),
  });
});

export const FirstMateToolkitHandlersLive = FirstMateToolkit.toLayer(make);
