import { HostResourcesSnapshot, ResourceTelemetrySummary } from "./resourceTelemetry.ts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const decode = Schema.decodeUnknownSync(HostResourcesSnapshot);
const decodeSummary = Schema.decodeUnknownSync(ResourceTelemetrySummary);

describe("HostResourcesSnapshot", () => {
  it("keeps storage optional for older connected environments", () => {
    expect(
      decode({
        sampledAt: 1,
        cpuUtilization: 0.5,
        cpuCount: 8,
        availableMemoryBytes: 4_000,
        totalMemoryBytes: 8_000,
      }).storage,
    ).toBeUndefined();
  });

  it("decodes privacy-safe workspace capacity", () => {
    expect(
      decode({
        sampledAt: 1,
        cpuUtilization: 0.5,
        cpuCount: 8,
        availableMemoryBytes: 4_000,
        totalMemoryBytes: 8_000,
        storage: {
          status: "available",
          volumes: [{ kind: "workspace", availableBytes: 25_000, totalBytes: 100_000 }],
        },
      }).storage,
    ).toEqual({
      status: "available",
      volumes: [{ kind: "workspace", availableBytes: 25_000, totalBytes: 100_000 }],
    });
  });
});

describe("ResourceTelemetrySummary", () => {
  it("decodes a server-only fallback without inventing CPU telemetry", () => {
    expect(
      decodeSummary({
        readAt: DateTime.makeUnsafe("2026-09-14T20:00:00.000Z"),
        status: "unavailable",
        coverage: "server-only",
        processCount: 1,
        currentCpuPercent: null,
        currentRssBytes: 240_000_000,
      }),
    ).toMatchObject({
      coverage: "server-only",
      processCount: 1,
      currentCpuPercent: null,
      currentRssBytes: 240_000_000,
    });
  });

  it("rejects negative fallback memory", () => {
    expect(() =>
      decodeSummary({
        readAt: DateTime.makeUnsafe("2026-09-14T20:00:00.000Z"),
        status: "unavailable",
        coverage: "server-only",
        processCount: 1,
        currentCpuPercent: null,
        currentRssBytes: -1,
      }),
    ).toThrow();
  });
});
