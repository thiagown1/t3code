import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowExactTokens,
  formatContextWindowPercentage,
  formatContextWindowTokens,
  presentContextWindow,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("presents compact values separately from exact provider measurements", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastInputTokens: 75_123,
        lastCachedInputTokens: 70_000,
        lastOutputTokens: 4_321,
        lastReasoningOutputTokens: 2_222,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(formatContextWindowTokens(snapshot!.usedTokens)).toBe("82k");
    expect(formatContextWindowExactTokens(snapshot!.usedTokens)).toBe("81,659");
    expect(formatContextWindowPercentage(snapshot!.usedPercentage)).toBe("31.6%");
    expect(presentContextWindow(snapshot!)).toEqual({
      compactValue: "31.6% · 82k / 258k",
      activeTokens: "81,659",
      maximumTokens: "258,400",
      usedPercentage: "31.6%",
      totalProcessedTokens: "748,126",
      lastInputTokens: "75,123",
      lastCachedInputTokens: "70,000",
      lastOutputTokens: "4,321",
      lastReasoningOutputTokens: "2,222",
      source: "Provider telemetry",
      updatedAt: "2026-03-23T00:00:00.000Z",
    });
  });

  it("marks values the provider omitted instead of estimating them", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", { usedTokens: 4_200 }),
    ]);

    expect(presentContextWindow(snapshot!)).toMatchObject({
      compactValue: "4.2k active",
      activeTokens: "4,200",
      maximumTokens: "Not reported",
      usedPercentage: "Not reported",
      totalProcessedTokens: "Not reported",
      lastInputTokens: "Not reported",
      lastCachedInputTokens: "Not reported",
      lastOutputTokens: "Not reported",
      lastReasoningOutputTokens: "Not reported",
    });
  });
});
