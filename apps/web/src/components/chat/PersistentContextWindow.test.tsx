import { EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { PersistentContextWindow } from "./PersistentContextWindow";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render }: { render: ReactNode }) => render,
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 81_659, maxTokens: 258_400 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-09-14T12:00:00.000Z",
  },
]);

if (!usage) throw new Error("Expected a context snapshot.");

describe("PersistentContextWindow", () => {
  it("keeps the precise context summary visible and opens provider details", () => {
    const markup = renderToStaticMarkup(
      <PersistentContextWindow
        usage={usage}
        modelDisplayName="GPT-6-Astra"
        providerDisplayName="Codex"
      />,
    );

    expect(markup).toContain('data-testid="persistent-context-window"');
    expect(markup).toContain('aria-label="Open context window details"');
    expect(markup).toContain("Context");
    expect(markup).toContain("31.6% · 82k / 258k");
    expect(markup).toContain("81,659 / 258,400");
  });

  it("shows an explicit unavailable state without inventing measurements", () => {
    const markup = renderToStaticMarkup(
      <PersistentContextWindow
        usage={null}
        unavailableMessage="Context has not been reported by this provider."
      />,
    );

    expect(markup).toContain("Context has not been reported by this provider.");
    expect(markup).not.toContain(">0%</span>");
  });
});
