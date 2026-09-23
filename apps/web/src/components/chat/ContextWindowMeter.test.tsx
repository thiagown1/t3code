import { EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: {
      usedTokens: 100_000,
      totalProcessedTokens: 750_000,
      maxTokens: 1_000_000,
      lastInputTokens: 12_345,
      lastCachedInputTokens: 10_000,
      lastOutputTokens: 2_345,
      lastReasoningOutputTokens: 1_234,
      compactsAutomatically: true,
    },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

describe("ContextWindowMeter", () => {
  it("keeps the hover popover open while the pointer moves to the compact button", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} onCompact={() => {}} />);

    expect(markup).toContain('data-close-delay="150"');
    expect(markup).toContain("Compact context");
  });

  it("closes an informational hover popover without delay", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).toContain('data-close-delay="0"');
    expect(markup).not.toContain("Compact context");
  });

  it("explains why the compact action is disabled", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={usage}
        onCompact={() => {}}
        compactDisabled
        compactDisabledReason="Send or clear your draft before compacting"
      />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Send or clear your draft before compacting<");
    expect(markup).not.toContain('aria-label="Send or clear your draft before compacting"');
  });

  it("shows exact measurements, model, provider source, and update time", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={usage}
        modelDisplayName="GPT-6-Astra"
        providerDisplayName="Codex"
        compactions={[
          {
            id: "compaction-1",
            createdAt: "2026-08-24T11:30:00.000Z",
            method: "manual",
            beforeTokens: 200_123,
            afterTokens: 40_456,
            detail: null,
          },
        ]}
      />,
    );

    expect(markup).toContain("100,000 / 1,000,000");
    expect(markup).toContain("10.0%");
    expect(markup).toContain("750,000");
    expect(markup).toContain("12,345");
    expect(markup).toContain("10,000");
    expect(markup).toContain("2,345");
    expect(markup).toContain("1,234");
    expect(markup).toContain("GPT-6-Astra");
    expect(markup).toContain("Provider telemetry · Codex");
    expect(markup).toContain('dateTime="2026-08-24T12:00:00.000Z"');
    expect(markup).toContain("Automatic · Provider-native");
    expect(markup).toContain("Manual");
    expect(markup).toContain("200,123 → 40,456");
    expect(markup).toContain('dateTime="2026-08-24T11:30:00.000Z"');
  });
});
