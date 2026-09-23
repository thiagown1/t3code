import { describe, expect, it } from "vite-plus/test";

import {
  countTrailingAutoContinues,
  decideTurnReviewAction,
  FIRST_MATE_CONTINUE_MESSAGE,
  parseTurnReviewVerdict,
  TURN_REVIEW_MAX_AUTO_CONTINUES,
  TURN_REVIEW_NEEDS_USER,
} from "./firstMateTurnReview.ts";

describe("decideTurnReviewAction", () => {
  const decide = (
    outcome: "done" | "continue" | "needs_user" | "blocked",
    outcomeConfidence: number,
    inScope = 1,
    consecutiveAutoContinues = 0,
  ) =>
    decideTurnReviewAction({
      verdict: { outcome, outcomeConfidence, inScope },
      consecutiveAutoContinues,
    });

  it("marks confident done verdicts done", () => {
    expect(decide("done", 0.8)).toBe("mark-done");
    expect(decide("done", 0.79)).toBe("open-decision");
  });

  it("continues only when confident and in scope", () => {
    expect(decide("continue", 0.9, 0.9)).toBe("continue");
    expect(decide("continue", 0.7, 0.9)).toBe("open-decision");
    expect(decide("continue", 0.9, 0.5)).toBe("open-decision");
  });

  it("stops continuing after the loop cap", () => {
    expect(decide("continue", 1, 1, TURN_REVIEW_MAX_AUTO_CONTINUES - 1)).toBe("continue");
    expect(decide("continue", 1, 1, TURN_REVIEW_MAX_AUTO_CONTINUES)).toBe("open-decision");
  });

  it("asks the user for anything else", () => {
    expect(decide("needs_user", 1)).toBe("open-decision");
    expect(decide("blocked", 1)).toBe("open-decision");
  });
});

describe("countTrailingAutoContinues", () => {
  it("counts automatic continues since the user last wrote", () => {
    const auto = { role: "user", text: FIRST_MATE_CONTINUE_MESSAGE };
    const reply = { role: "assistant", text: "Working on it." };
    expect(
      countTrailingAutoContinues([
        auto,
        reply,
        { role: "user", text: "Fix the login page" },
        reply,
        auto,
        reply,
        auto,
        reply,
      ]),
    ).toBe(2);
    expect(countTrailingAutoContinues([{ role: "user", text: "Hi" }, reply])).toBe(0);
  });
});

describe("parseTurnReviewVerdict", () => {
  it("reads objects and fenced JSON", () => {
    expect(parseTurnReviewVerdict({ outcome: "done", confidence: 0.9, in_scope: 1 })).toEqual({
      outcome: "done",
      outcomeConfidence: 0.9,
      inScope: 1,
    });
    expect(
      parseTurnReviewVerdict(
        '```json\n{"outcome":"continue","confidence":0.85,"in_scope":0.95}\n```',
      ),
    ).toEqual({ outcome: "continue", outcomeConfidence: 0.85, inScope: 0.95 });
  });

  it("falls back to needs_user on anything malformed", () => {
    expect(parseTurnReviewVerdict("not json")).toEqual(TURN_REVIEW_NEEDS_USER);
    expect(parseTurnReviewVerdict({ outcome: "maybe", confidence: 1, in_scope: 1 })).toEqual(
      TURN_REVIEW_NEEDS_USER,
    );
    expect(parseTurnReviewVerdict({ outcome: "done", confidence: 3, in_scope: 1 })).toEqual(
      TURN_REVIEW_NEEDS_USER,
    );
  });
});
