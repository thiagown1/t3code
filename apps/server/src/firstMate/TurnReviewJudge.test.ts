import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { JevDecisions, type JevAnswers } from "./JevDecisions.ts";
import { layer, TurnReviewJudge, type TurnReviewState } from "./TurnReviewJudge.ts";

const STATE: TurnReviewState = {
  title: "Calculator",
  originalRequest: "Build a calculator app.",
  latestRequest: "Add tests too.",
  lastAssistantMessageTail: "Added tests; all pass.",
  turnState: "completed",
};

const unused = () => Effect.die("unused");

function judgeWith(input: {
  readonly jevAnswers?: JevAnswers;
  readonly modelAnswer?: TextGeneration.TurnReviewGenerationResult;
}) {
  return Effect.service(TurnReviewJudge).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(JevDecisions, {
              decide: () => Effect.succeed(input.jevAnswers ?? {}),
            }),
            Layer.succeed(
              TextGeneration.TextGeneration,
              TextGeneration.TextGeneration.of({
                generateCommitMessage: unused,
                generatePrContent: unused,
                generateBranchName: unused,
                generateThreadTitle: unused,
                generateRoundSummary: unused,
                generateTurnReview: () =>
                  Effect.succeed(
                    input.modelAnswer ?? { outcome: "done", confidence: 1, in_scope: 1 },
                  ),
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

const modelInput = {
  mode: "model" as const,
  state: STATE,
  cwd: "/workspace",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "haiku" },
};

describe("TurnReviewJudge", () => {
  it.effect("reads Jev's typed answers into a verdict", () =>
    Effect.gen(function* () {
      const judge = yield* judgeWith({
        jevAnswers: {
          outcome: { type: "choice", choice: "continue", confidence: 0.87 },
          in_scope: { type: "noul", noul: 0.91 },
        },
      });
      expect(yield* judge.review({ mode: "jev", state: STATE })).toEqual({
        outcome: "continue",
        outcomeConfidence: 0.87,
        inScope: 0.91,
      });
    }),
  );

  it.effect("returns the same verdict shape from the model judge", () =>
    Effect.gen(function* () {
      const judge = yield* judgeWith({
        modelAnswer: { outcome: "continue", confidence: 0.87, in_scope: 0.91 },
      });
      expect(yield* judge.review(modelInput)).toEqual({
        outcome: "continue",
        outcomeConfidence: 0.87,
        inScope: 0.91,
      });
    }),
  );

  it.effect("treats a malformed model answer as needing the user", () =>
    Effect.gen(function* () {
      const judge = yield* judgeWith({
        modelAnswer: { outcome: "probably done?", confidence: 7, in_scope: -1 },
      });
      expect(yield* judge.review(modelInput)).toEqual({
        outcome: "needs_user",
        outcomeConfidence: 0,
        inScope: 0,
      });
    }),
  );

  it.effect("treats an unknown Jev choice as needing the user", () =>
    Effect.gen(function* () {
      const judge = yield* judgeWith({
        jevAnswers: { outcome: { type: "choice", choice: "shrug", confidence: 1 } },
      });
      expect(yield* judge.review({ mode: "jev", state: STATE })).toMatchObject({
        outcome: "needs_user",
        outcomeConfidence: 0,
      });
    }),
  );
});
