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

    expect(summarizeResourceTelemetry(snapshot)).toEqual({
      readAt: DateTime.makeUnsafe(1_000),
      status: "healthy",
      processCount: 3,
      currentCpuPercent: 12.5,
      currentRssBytes: 4_096,
    });
    expect(summarizeResourceTelemetry(snapshot)).not.toHaveProperty("processes");
  });
});
