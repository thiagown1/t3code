import { EventId, TurnId } from "@t3tools/contracts";
import { deriveLatestContextWindowSnapshot } from "@t3tools/shared/contextWindow";
import { describe, expect, it } from "vite-plus/test";

import { formatContextWindowAlert } from "./PersistentContextWindow.logic";

describe("formatContextWindowAlert", () => {
  it("keeps exact provider measurements separate from the compact summary", () => {
    const usage = deriveLatestContextWindowSnapshot([
      {
        id: EventId.make("activity-1"),
        tone: "info",
        kind: "context-window.updated",
        summary: "Context updated",
        payload: {
          usedTokens: 81_659,
          totalProcessedTokens: 748_126,
          maxTokens: 258_400,
          lastInputTokens: 75_123,
          lastCachedInputTokens: 70_000,
          lastOutputTokens: 4_321,
          lastReasoningOutputTokens: 2_222,
        },
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-09-14T12:00:00.000Z",
      },
    ]);

    expect(usage).not.toBeNull();
    const detail = formatContextWindowAlert({
      usage: usage!,
      modelDisplayName: "GPT-6-Astra",
      providerDisplayName: "Codex",
    });

    expect(detail).toContain("Active context: 81,659 / 258,400");
    expect(detail).toContain("Used: 31.6%");
    expect(detail).toContain("Total processed: 748,126");
    expect(detail).toContain("Model: GPT-6-Astra");
    expect(detail).toContain("Source: Provider telemetry · Codex");
    expect(detail).toContain("Input: 75,123");
    expect(detail).toContain("Cache read: 70,000");
    expect(detail).toContain("Output: 4,321");
    expect(detail).toContain("Reasoning: 2,222");
  });
});
