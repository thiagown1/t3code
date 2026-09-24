/**
 * TurnReviewJudge - one interface over the two FirstMate turn review judges.
 *
 * Jev (OpenRouter Decisions) and a cheap text-generation model both answer the
 * same two questions about a finished turn and return the same verdict shape,
 * so the review policy never knows which one ran. A judge that cannot run (no
 * key, provider down) fails; a judge that runs but answers off-contract is read
 * as "needs the user", which can only ever open a decision.
 *
 * @module TurnReviewJudge
 */
import type { ModelSelection } from "@t3tools/contracts";
import {
  parseTurnReviewVerdict,
  TURN_REVIEW_NEEDS_USER,
  TURN_REVIEW_OUTCOMES,
  type TurnReviewVerdict,
} from "@t3tools/shared/firstMateTurnReview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { JevDecisions, type JevAnswers } from "./JevDecisions.ts";

/** What a judge reads about the turn. Every field is already bounded. */
export interface TurnReviewState {
  readonly title: string;
  readonly originalRequest: string;
  readonly latestRequest: string;
  readonly lastAssistantMessageTail: string;
  readonly turnState: "completed" | "failed";
}

export type TurnReviewJudgeInput =
  | { readonly mode: "jev"; readonly state: TurnReviewState }
  | {
      readonly mode: "model";
      readonly state: TurnReviewState;
      readonly cwd: string;
      readonly modelSelection: ModelSelection;
    };

export class TurnReviewJudgeError extends Schema.TaggedError<TurnReviewJudgeError>()(
  "TurnReviewJudgeError",
  {
    judge: Schema.Literals(["jev", "model"]),
    /** `unavailable` means the judge is not configured, not that it broke. */
    reason: Schema.Literals(["unavailable", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Turn review (${this.judge}) ${this.reason}: ${this.detail}`;
  }
}

export class TurnReviewJudge extends Context.Service<
  TurnReviewJudge,
  {
    readonly review: (
      input: TurnReviewJudgeInput,
    ) => Effect.Effect<TurnReviewVerdict, TurnReviewJudgeError>;
  }
>()("t3/firstMate/TurnReviewJudge") {}

const OUTCOME_CRITERIA = {
  done: "The original request is fully delivered and there is nothing left to do.",
  continue:
    "The agent stopped with clear remaining work inside the original request that it can do itself.",
  needs_user:
    "The agent asked a question, proposed options, or needs approval or information from the user.",
  blocked: "An error, a failure, or missing access stopped the work.",
} as const;

const JEV_QUESTIONS = {
  outcome: {
    type: "choice",
    instructions: "Where did this coding agent's turn leave the user's original request?",
    criteria: OUTCOME_CRITERIA,
  },
  in_scope: {
    type: "noul",
    instructions:
      "Does the agent's next step stay within the original request? Deploys, production changes, merges, deleting data, spending money, and new scope are out of scope.",
    criteria: {
      true: "The next step stays within the original request and is none of the excluded actions.",
      false: "The next step goes beyond the original request or is one of the excluded actions.",
    },
  },
} as const;

/** @internal Exported for tests. */
function verdictFromJevAnswers(answers: JevAnswers): TurnReviewVerdict {
  const outcome = answers.outcome;
  const inScope = answers.in_scope;
  if (outcome?.type !== "choice") return TURN_REVIEW_NEEDS_USER;
  const known = TURN_REVIEW_OUTCOMES.find((candidate) => candidate === outcome.choice);
  if (known === undefined) return TURN_REVIEW_NEEDS_USER;
  return {
    outcome: known,
    outcomeConfidence: outcome.confidence,
    inScope: inScope?.type === "noul" ? inScope.noul : 0,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const jev = yield* JevDecisions;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const review: TurnReviewJudge["Service"]["review"] = (input) =>
    input.mode === "jev"
      ? jev.decide({ state: { ...input.state }, questions: JEV_QUESTIONS }).pipe(
          Effect.map(verdictFromJevAnswers),
          Effect.mapError(
            (error) =>
              new TurnReviewJudgeError({
                judge: "jev",
                reason: error.reason === "unavailable" ? "unavailable" : "failed",
                detail: error.detail,
              }),
          ),
        )
      : textGeneration
          .generateTurnReview({
            cwd: input.cwd,
            state: JSON.stringify(input.state, null, 2),
            modelSelection: input.modelSelection,
          })
          .pipe(
            Effect.map(parseTurnReviewVerdict),
            Effect.mapError(
              (error) =>
                new TurnReviewJudgeError({
                  judge: "model",
                  reason: "failed",
                  detail: error.detail,
                }),
            ),
          );

  return TurnReviewJudge.of({ review });
});

export const layer = Layer.effect(TurnReviewJudge, make);
