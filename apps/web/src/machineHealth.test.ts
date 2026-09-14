import type { HostResourcesSnapshot, ResourceTelemetrySummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveMachineHealth, MACHINE_HEALTH_STALE_AFTER_MS } from "./machineHealth";

const now = 1_000_000;
const host = {
  sampledAt: now,
  cpuUtilization: 0.25,
  cpuCount: 8,
  availableMemoryBytes: 12_000,
  totalMemoryBytes: 16_000,
  storage: {
    status: "available",
    volumes: [{ kind: "workspace", availableBytes: 75_000, totalBytes: 100_000 }],
  },
} satisfies HostResourcesSnapshot;

const telemetry = {
  readAt: DateTime.makeUnsafe(now),
  status: "healthy",
  processCount: 1,
  currentCpuPercent: 12,
  currentRssBytes: 1_024,
} satisfies ResourceTelemetrySummary;

function derive(overrides: Partial<Parameters<typeof deriveMachineHealth>[0]> = {}) {
  return deriveMachineHealth({
    connected: true,
    failed: false,
    pending: false,
    now,
    hostReceivedAt: now,
    telemetryReceivedAt: now,
    host,
    telemetry,
    ...overrides,
  });
}

describe("deriveMachineHealth", () => {
  it("separates host utilization from the T3 process footprint", () => {
    expect(derive()).toMatchObject({
      level: "healthy",
      hostCpuUtilization: 0.25,
      hostMemoryUtilization: 0.25,
      storageUtilization: 0.25,
      t3CpuPercent: 12,
      t3MemoryBytes: 1_024,
    });
  });

  it("prioritizes critical pressure and stale samples", () => {
    expect(
      derive({
        host: { ...host, availableMemoryBytes: 100 },
      }).level,
    ).toBe("critical");
    expect(
      derive({
        now: now + MACHINE_HEALTH_STALE_AFTER_MS + 1,
      }).level,
    ).toBe("stale");
  });

  it("distinguishes unavailable, failed, and partial collection", () => {
    expect(derive({ connected: false }).level).toBe("unavailable");
    expect(derive({ host: null, failed: true }).level).toBe("error");
    expect(derive({ telemetry: null, telemetryReceivedAt: null }).level).toBe("partial");
    expect(derive({ telemetry: { ...telemetry, status: "degraded" } }).level).toBe("partial");
    expect(
      derive({
        host: { ...host, storage: { status: "error", volumes: [] } },
      }).level,
    ).toBe("partial");
  });
});
