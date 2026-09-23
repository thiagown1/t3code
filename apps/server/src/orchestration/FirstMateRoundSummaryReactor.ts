/**
 * FirstMateRoundSummaryReactor - cheap round summaries for delegated threads.
 *
 * FirstMate's supervisor has to decide what happens next without rereading the
 * threads it delegated to. Rereading them with the thread's own model is the
 * expensive way to learn what a round produced, so this reactor pays a small,
 * separately configured model once per finished round instead: the summary is
 * generated on the project's `textGenerationModelSelection`, the same setting
 * behind commit messages and thread titles, so swapping providers in
 * Settings → Provider moves this work with it.
 *
 * Only threads a FirstMate topic is delegated to are summarized. The summary is
 * auxiliary: every failure is logged and dropped, and no other flow waits on it.
 *
 * @module FirstMateRoundSummaryReactor
 */
import {
  CommandId,
  type FirstMateTopic,
  type FirstMateTopicId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { formatRoundTranscript } from "../textGeneration/RoundSummaryContext.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "./Services/RuntimeReceiptBus.ts";

export class FirstMateRoundSummaryReactor extends Context.Service<
  FirstMateRoundSummaryReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/FirstMateRoundSummaryReactor") {}

interface RoundInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

type SummaryOutcome = {
  readonly outcome: "recorded" | "skipped" | "failed";
  readonly topicId: FirstMateTopicId | null;
};

const skipped = (topicId: FirstMateTopicId | null = null): SummaryOutcome => ({
  outcome: "skipped",
  topicId,
});

/**
 * Only a round that ran to an answer or an error is worth summarizing. An
 * interrupted or cancelled turn says more about the user than about the work.
 */
function summarizableTurn(event: ProviderRuntimeEvent): RoundInput | null {
  if (event.type !== "turn.completed") return null;
  if (event.payload.state !== "completed" && event.payload.state !== "failed") return null;
  return event.turnId === undefined ? null : { threadId: event.threadId, turnId: event.turnId };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receiptBus = yield* RuntimeReceiptBus;
  const crypto = yield* Crypto.Crypto;

  const summarize = Effect.fn("FirstMateRoundSummaryReactor.summarize")(function* (
    input: RoundInput,
  ) {
    const threadOption = yield* snapshots.getThreadShellById(input.threadId);
    if (Option.isNone(threadOption)) return skipped();
    const thread = threadOption.value;

    // Live work means this round is not the thread's last word. Waiting costs
    // nothing: the turn that finishes the work will summarize the later state.
    if (thread.backgroundLiveness != null) return skipped();
    if (thread.session !== null && thread.session.activeTurnId !== null) {
      if (thread.session.activeTurnId !== input.turnId) return skipped();
      if (thread.session.status === "running" || thread.session.status === "starting") {
        return skipped();
      }
    }

    const projectOption = yield* snapshots.getProjectShellById(thread.projectId);
    if (Option.isNone(projectOption)) return skipped();
    const project = projectOption.value;
    const workspace = project.firstMate ?? null;
    if (workspace === null) return skipped();
    if (workspace.supervisorThreadId === thread.id) return skipped();

    const topic: FirstMateTopic | undefined = workspace.topics.find(
      (entry) => entry.threadId === thread.id,
    );
    if (topic === undefined) return skipped();
    // The decider rejects a repeat too. Checking here keeps the model call,
    // not just the write, out of a replayed or duplicated turn event.
    if (topic.latestRoundSummary?.turnId === input.turnId) return skipped(topic.id);

    const detailOption = yield* snapshots.getThreadDetailSnapshot(thread.id, { turnLimit: 1 });
    if (Option.isNone(detailOption)) return skipped(topic.id);
    const messages = detailOption.value.thread.messages;
    // Providers that leave `turnId` unset on messages still get a bounded
    // transcript: the window is already scoped to the last round.
    const roundMessages = messages.filter((message) => message.turnId === input.turnId);
    const transcript = formatRoundTranscript(roundMessages.length > 0 ? roundMessages : messages);
    if (transcript.length === 0) return skipped(topic.id);

    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      yield* settingsService.getSettings,
      thread.projectId,
    ).settings;

    const generated = yield* textGeneration.generateRoundSummary({
      cwd: thread.worktreePath ?? project.workspaceRoot,
      topicTitle: topic.title,
      topicSummary: topic.summary,
      transcript,
      modelSelection,
    });
    if (generated.summary.length === 0) return skipped(topic.id);

    const uuid = yield* crypto.randomUUIDv4;
    yield* engine.dispatch({
      type: "firstmate.topic.record-round-summary",
      commandId: CommandId.make(`server:fm-round-summary:${thread.id}:${uuid}`),
      projectId: project.id,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      topicId: topic.id,
      threadId: thread.id,
      turnId: input.turnId,
      text: generated.summary,
    });
    return { outcome: "recorded", topicId: topic.id } satisfies SummaryOutcome;
  });

  const processRound = (input: RoundInput) =>
    summarize(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("first mate round summary skipped", {
              threadId: input.threadId,
              turnId: input.turnId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ outcome: "failed", topicId: null } satisfies SummaryOutcome)),
      ),
      Effect.flatMap((result) =>
        Effect.flatMap(DateTime.now, (now) =>
          receiptBus.publish({
            type: "firstmate.round-summary.settled",
            threadId: input.threadId,
            turnId: input.turnId,
            topicId: result.topicId,
            outcome: result.outcome,
            createdAt: DateTime.formatIso(now),
          }),
        ),
      ),
    );

  const worker = yield* makeDrainableWorker(processRound);

  const start = Effect.fn("FirstMateRoundSummaryReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        const round = summarizableTurn(event);
        return round === null ? Effect.void : worker.enqueue(round);
      }),
    );
  });

  return { start, drain: worker.drain } satisfies FirstMateRoundSummaryReactor["Service"];
});

export const layer = Layer.effect(FirstMateRoundSummaryReactor, make);
