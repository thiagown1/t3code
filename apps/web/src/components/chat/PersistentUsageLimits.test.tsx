import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PersistentUsageLimits } from "./PersistentUsageLimits";

describe("PersistentUsageLimits", () => {
  it("keeps the active account, all windows, and renewal times in the composer", () => {
    const markup = renderToStaticMarkup(
      <PersistentUsageLimits
        summary={{
          status: "available",
          accountLabel: "Codex · Work",
          accountCount: 2,
          checkedAt: "2026-09-03T11:55:00.000Z",
          windows: [
            {
              id: "session",
              kind: "session",
              label: "Session",
              remainingPercent: 60,
              resetsIn: "resets in 2h 0m",
            },
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              remainingPercent: 75,
              resetsIn: "resets in 5d 0h",
            },
          ],
        }}
        onOpen={() => {}}
      />,
    );

    expect(markup).toContain('data-testid="persistent-usage-limits"');
    expect(markup).toContain("Codex · Work +1");
    expect(markup).toContain("Session 60%, resets in 2h 0m · Weekly 75%, resets in 5d 0h");
    expect(markup).toContain('aria-label="Open usage limits"');
  });

  it("shows stale state without rendering an old exact percentage", () => {
    const markup = renderToStaticMarkup(
      <PersistentUsageLimits
        summary={{
          status: "stale",
          accountLabel: "Codex",
          accountCount: 1,
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [],
          message: "Usage reading is stale.",
        }}
        onOpen={() => {}}
      />,
    );

    expect(markup).toContain("Usage reading is stale.");
    expect(markup).not.toContain("Session 60%");
  });
});
