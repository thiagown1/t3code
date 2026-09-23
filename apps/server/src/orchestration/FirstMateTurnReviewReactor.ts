/**
 * FirstMateTurnReviewReactor - keeps FirstMate threads from stalling.
 *
 * Agents often end a turn without formally asking anything: they report
 * success, stop with work left, or ask in plain text. Nothing reacted to that,
 * so finished work stayed open and stalled work stayed stalled. When any
 * thread in a FirstMate project finishes a turn, this reactor asks a cheap
 * judge (Jev or a cheap model, per the `firstMateTurnReview` setting) whether
 * the work is done, should continue, or needs the user, and acts on it:
 *
 * - confidently done: mark the thread `done` (the next user turn reopens it);
 * - confidently continuing inside the original request: queue a fixed
 *   continue message, at most `TURN_REVIEW_MAX_AUTO_CONTINUES` in a row;
 * - anything else: open a turn-review decision card for the user.
 *
 * The review is auxiliary: every failure is logged and dropped, and a judge
 * that is not configured simply means no review.
 *
 * @module FirstMateTurnReviewReactor
 */
import {
  CommandId,
  FirstMateDecisionId,
  type FirstMateDecision,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  countTrailingAutoContinues,
  decideTurnReviewAction,
  FIRST_MATE_CONTINUE_MESSAGE,
  TURN_REVIEW_OPTION_IDS,
  type TurnReviewVerdict,
} from "@t3tools/shared/firstMateTurnReview";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { TurnReviewJudge, type TurnReviewState } from "../firstMate/TurnReviewJudge.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import {
  turnReviewContinueCommand,
  turnReviewMarkDoneCommand,
} from "./firstMateTurnReviewCommands.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type FirstMateTurnReviewReceipt,
} from "./Services/RuntimeReceiptBus.ts";

export class FirstMateTurnReviewReactor extends Context.Service<
  FirstMateTurnReviewReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/FirstMateTurnReviewReactor") {}

interface ReviewInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly turnState: "completed" | "failed";
}

type ReviewOutcome = FirstMateTurnReviewReceipt["outcome"];
const skipped: ReviewOutcome = "skipped";

const MAX_REQUEST_CHARS = 2_000;
const MAX_ASSISTANT_TAIL_CHARS = 4_000;
const MAX_QUESTION_CHARS = 1_500;

function reviewableTurn(event: ProviderRuntimeEvent): ReviewInput | null {
  if (event.type !== "turn.completed") return null;
  const state = event.payload.state;
  if (state !== "completed" && state !== "failed") return null;
  return event.turnId === undefined
    ? null
    : { threadId: event.threadId, turnId: event.turnId, turnState: state };
}

function head(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function tail(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-(limit - 1)).trimStart()}`;
}

/** Decision id for one reviewed turn; deterministic so a replay cannot open two cards. */
export function turnReviewDecisionId(threadId: ThreadId, turnId: TurnId): FirstMateDecisionId {
  return FirstMateDecisionId.make(`turn-review:${threadId}:${turnId}`);
}

function recommendedOption(verdict: TurnReviewVerdict): string {
  switch (verdict.outcome) {
    case "done":
      return TURN_REVIEW_OPTION_IDS.markDone;
    case "continue":
      return TURN_REVIEW_OPTION_IDS.continue;
    default:
      return TURN_REVIEW_OPTION_IDS.answerMyself;
  }
}

function isPendingTurnReview(
  decision: FirstMateDecision,
  threadId: ThreadId,
): decision is FirstMateDecision & {
  readonly source: Extract<FirstMateDecision["source"], { kind: "turn-review" }>;
} {
  return (
    decision.status === "pending" &&
    decision.source.kind === "turn-review" &&
    decision.source.threadId === threadId
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const judge = yield* TurnReviewJudge;
  const receiptBus = yield* RuntimeReceiptBus;
  // A provider can report the same turn end twice; the judge is paid once.
  const reviewedTurns = new Set<string>();

  const review = Effect.fn("FirstMateTurnReviewReactor.review")(function* (input: ReviewInput) {
    const reviewKey = `${input.threadId}:${input.turnId}`;
    if (reviewedTurns.has(reviewKey)) return skipped;

    const threadOption = yield* snapshots.getThreadShellById(input.threadId);
    if (Option.isNone(threadOption)) return skipped;
    const thread = threadOption.value;
    if (thread.archivedAt !== null) return skipped;

    // Live work means this turn is not the thread's last word.
    if (thread.backgroundLiveness != null) return skipped;
    if (thread.session !== null && thread.session.activeTurnId !== null) {
      if (thread.session.activeTurnId !== input.turnId) return skipped;
      if (thread.session.status === "running" || thread.session.status === "starting") {
        return skipped;
      }
    }

    const projectOption = yield* snapshots.getProjectShellById(thread.projectId);
    if (Option.isNone(projectOption)) return skipped;
    const project = projectOption.value;
    const workspace = project.firstMate ?? null;
    if (workspace === null) return skipped;
    if (workspace.supervisorThreadId === thread.id) return skipped;

    const decisionId = turnReviewDecisionId(thread.id, input.turnId);
    if (workspace.decisions.some((decision) => decision.id === decisionId)) return skipped;

    // A newer turn makes an older review card stale: whatever it asked about
    // has moved on, so it leaves the inbox before anything else happens.
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    for (const stale of workspace.decisions.filter((decision) =>
      isPendingTurnReview(decision, thread.id),
    )) {
      yield* engine.dispatch({
        type: "firstmate.decision.cancel",
        commandId: CommandId.make(`server:firstmate-turn-review-cancel:${stale.id}`),
        projectId: project.id,
        decisionId: stale.id,
        createdAt,
      });
    }

    // A pending request is already a decision; a set delivery status is the
    // user's own call about this thread.
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) return skipped;
    if (thread.deliveryStatus != null) return skipped;

    const settings = resolveProjectSettings(
      yield* settingsService.getSettings,
      thread.projectId,
    ).settings;
    const mode = settings.firstMateTurnReview;
    if (mode === "off") return skipped;

    const detailOption = yield* snapshots.getThreadDetailById(thread.id, { activityKinds: [] });
    if (Option.isNone(detailOption)) return skipped;
    const messages = detailOption.value.messages;
    const userMessages = messages.filter((message) => message.role === "user");
    const lastAssistant = messages.findLast((message) => message.role === "assistant");
    const originalRequest = userMessages.find(
      (message) => message.text.trim() !== FIRST_MATE_CONTINUE_MESSAGE,
    );
    const lastAssistantText = assistantCitationsToPlainText(lastAssistant?.text ?? "").trim();

    const state: TurnReviewState = {
      title: thread.title,
      originalRequest: head(originalRequest?.text ?? thread.title, MAX_REQUEST_CHARS),
      latestRequest: head(userMessages.at(-1)?.text ?? "", MAX_REQUEST_CHARS),
      lastAssistantMessageTail: tail(lastAssistantText, MAX_ASSISTANT_TAIL_CHARS),
      turnState: input.turnState,
    };

    reviewedTurns.add(reviewKey);
    const verdictOption = yield* judge
      .review(
        mode === "jev"
          ? { mode, state }
          : {
              mode,
              state,
              cwd: thread.worktreePath ?? project.workspaceRoot,
              modelSelection:
                settings.firstMateTurnReviewModelSelection ?? settings.textGenerationModelSelection,
            },
      )
      .pipe(
        Effect.map(Option.some),
        // An unconfigured judge (Jev without a key) means "no review", not a failure.
        Effect.catch((error) =>
          error.reason === "unavailable"
            ? Effect.succeed(Option.none<TurnReviewVerdict>())
            : Effect.fail(error),
        ),
      );
    if (Option.isNone(verdictOption)) return skipped;
    const verdict = verdictOption.value;

    const action = decideTurnReviewAction({
      verdict,
      consecutiveAutoContinues: countTrailingAutoContinues(messages),
    });
    const key = reviewKey;
    let command: OrchestrationCommand;
    let outcome: ReviewOutcome;
    if (action === "mark-done") {
      command = turnReviewMarkDoneCommand({ threadId: thread.id, key });
      outcome = "marked-done";
    } else if (action === "continue") {
      command = turnReviewContinueCommand({ threadId: thread.id, key, createdAt });
      outcome = "continued";
    } else {
      const topic = workspace.topics.find((entry) => entry.threadId === thread.id);
      command = {
        type: "firstmate.decision.open",
        commandId: CommandId.make(`server:firstmate-turn-review-open:${key}`),
        projectId: project.id,
        createdAt,
        decisionId,
        topicId: topic?.id ?? null,
        source: { kind: "turn-review", threadId: thread.id, turnId: input.turnId },
        question:
          lastAssistantText.length > 0
            ? tail(lastAssistantText, MAX_QUESTION_CHARS)
            : "The agent ended its turn without a message. What should happen next?",
        options: [
          {
            id: TURN_REVIEW_OPTION_IDS.continue,
            label: "Continue as proposed",
            description: "Ask the agent to continue the remaining work within the request.",
          },
          {
            id: TURN_REVIEW_OPTION_IDS.markDone,
            label: "Mark done",
            description: "Mark this thread done. Sending it a new message reopens it.",
          },
          {
            id: TURN_REVIEW_OPTION_IDS.answerMyself,
            label: "I'll answer in the thread",
            description: "Do nothing now; reply to the agent yourself.",
          },
        ],
        recommendedOptionId: recommendedOption(verdict),
        blocking: verdict.outcome === "needs_user" || verdict.outcome === "blocked",
      };
      outcome = "decision-opened";
    }
    yield* engine.dispatch(command);
    return outcome;
  });

  const processTurn = (input: ReviewInput) =>
    review(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("first mate turn review skipped", {
              threadId: input.threadId,
              turnId: input.turnId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as<ReviewOutcome>("failed")),
      ),
      Effect.flatMap((outcome) =>
        Effect.flatMap(DateTime.now, (now) =>
          receiptBus.publish({
            type: "firstmate.turn-review.settled",
            threadId: input.threadId,
            turnId: input.turnId,
            outcome,
            createdAt: DateTime.formatIso(now),
          }),
        ),
      ),
    );

  const worker = yield* makeDrainableWorker(processTurn);

  const start = Effect.fn("FirstMateTurnReviewReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        const turn = reviewableTurn(event);
        return turn === null ? Effect.void : worker.enqueue(turn);
      }),
    );
  });

  return { start, drain: worker.drain } satisfies FirstMateTurnReviewReactor["Service"];
});

export const layer = Layer.effect(FirstMateTurnReviewReactor, make);
