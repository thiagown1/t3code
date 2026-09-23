import type { ResourceTelemetrySnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { summarizeResourceTelemetry } from "./ResourceTelemetrySummary.ts";

describe("summarizeResourceTelemetry", () => {
  it("keeps aggregate usage and omits process details", () => {
    const snapshot = {
      readAt: DateTime.makeUnsafe(1_000),
      processes: [{ command: "secret --token value" }],
      groups: {
        allT3: {
          processCount: 3,
          currentCpuPercent: 12.5,
          currentRssBytes: 4_096,
        },
      },
      health: { native: { status: "healthy" } },
    } as unknown as ResourceTelemetrySnapshot;

    expect(summarizeResourceTelemetry(snapshot, { serverRssBytes: 8_192 })).toEqual({
      readAt: DateTime.makeUnsafe(1_000),
      status: "healthy",
      coverage: "full",
      processCount: 3,
      currentCpuPercent: 12.5,
      currentRssBytes: 4_096,
    });
    expect(summarizeResourceTelemetry(snapshot, { serverRssBytes: 8_192 })).not.toHaveProperty(
      "processes",
    );
  });

  it("falls back to server memory without claiming child-process coverage", () => {
    const snapshot = {
      readAt: DateTime.makeUnsafe(1_000),
      groups: {
        allT3: { processCount: 0, currentCpuPercent: 0, currentRssBytes: 0 },
      },
      health: { native: { status: "unavailable" } },
    } as unknown as ResourceTelemetrySnapshot;

    expect(summarizeResourceTelemetry(snapshot, { serverRssBytes: 12_345 })).toEqual({
      readAt: DateTime.makeUnsafe(1_000),
      status: "unavailable",
      coverage: "server-only",
      processCount: 1,
      currentCpuPercent: null,
      currentRssBytes: 12_345,
    });
  });
});
