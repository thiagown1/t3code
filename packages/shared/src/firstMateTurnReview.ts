/**
 * FirstMate turn review policy.
 *
 * When a thread in a FirstMate project finishes a turn, a cheap judge reads it
 * and reports an outcome with a confidence. This module turns that verdict
 * into exactly one action, so every judge (Jev, a cheap model, a test fake)
 * behaves the same afterwards. Only confident, in-scope verdicts act on their
 * own; everything else becomes a decision for the user.
 *
 * @module firstMateTurnReview
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const TURN_REVIEW_OUTCOMES = ["done", "continue", "needs_user", "blocked"] as const;
export type TurnReviewOutcome = (typeof TURN_REVIEW_OUTCOMES)[number];

export interface TurnReviewVerdict {
  readonly outcome: TurnReviewOutcome;
  /** 0-1 confidence in `outcome`. */
  readonly outcomeConfidence: number;
  /** 0-1 likelihood that the next step stays inside the original request. */
  readonly inScope: number;
}

export type TurnReviewAction = "mark-done" | "continue" | "open-decision";

const TURN_REVIEW_CONFIDENCE_THRESHOLD = 0.8;
const TURN_REVIEW_IN_SCOPE_THRESHOLD = 0.8;
/** Automatic continues allowed in a row before the user has to weigh in. */
export const TURN_REVIEW_MAX_AUTO_CONTINUES = 5;

/**
 * The message an automatic continue sends. It doubles as the marker that
 * identifies automatic continues in a thread's history, so it must stay
 * byte-for-byte stable.
 */
export const FIRST_MATE_CONTINUE_MESSAGE =
  "Continue the remaining work toward the original request. Stay in scope; if you need a decision, ask with your question tool.";

export const TURN_REVIEW_OPTION_IDS = {
  continue: "continue",
  markDone: "mark-done",
  answerMyself: "answer-myself",
} as const;

export const TURN_REVIEW_NEEDS_USER: TurnReviewVerdict = {
  outcome: "needs_user",
  outcomeConfidence: 0,
  inScope: 0,
};

export function decideTurnReviewAction(input: {
  readonly verdict: TurnReviewVerdict;
  readonly consecutiveAutoContinues: number;
}): TurnReviewAction {
  const { verdict } = input;
  if (verdict.outcome === "done" && verdict.outcomeConfidence >= TURN_REVIEW_CONFIDENCE_THRESHOLD) {
    return "mark-done";
  }
  if (
    verdict.outcome === "continue" &&
    verdict.outcomeConfidence >= TURN_REVIEW_CONFIDENCE_THRESHOLD &&
    verdict.inScope >= TURN_REVIEW_IN_SCOPE_THRESHOLD &&
    input.consecutiveAutoContinues < TURN_REVIEW_MAX_AUTO_CONTINUES
  ) {
    return "continue";
  }
  return "open-decision";
}

/**
 * How many automatic continues the thread has received since the user last
 * wrote. Reads the thread's messages oldest-first and counts the trailing run
 * of user messages that are the fixed continue message.
 */
export function countTrailingAutoContinues(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (message.text.trim() !== FIRST_MATE_CONTINUE_MESSAGE) break;
    count += 1;
  }
  return count;
}

const Unit = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const ModelVerdict = Schema.Struct({
  outcome: Schema.Literals(TURN_REVIEW_OUTCOMES),
  confidence: Unit,
  in_scope: Unit,
});
const decodeModelVerdict = Schema.decodeUnknownOption(ModelVerdict);

function parseJsonText(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Read a model judge's answer: an object or JSON text (code fences allowed)
 * shaped `{"outcome","confidence","in_scope"}`. Anything else counts as
 * "needs the user" with no confidence, which can only ever open a decision.
 */
export function parseTurnReviewVerdict(raw: unknown): TurnReviewVerdict {
  const value = typeof raw === "string" ? parseJsonText(raw) : raw;
  return Option.match(decodeModelVerdict(value), {
    onNone: () => TURN_REVIEW_NEEDS_USER,
    onSome: (verdict) => ({
      outcome: verdict.outcome,
      outcomeConfidence: verdict.confidence,
      inScope: verdict.in_scope,
    }),
  });
}
