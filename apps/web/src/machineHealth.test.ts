import type { HostResourcesSnapshot, ResourceTelemetrySummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  appendMachineHealthHistory,
  deriveMachineHealth,
  machineHealthHistoryPeaks,
  MACHINE_HEALTH_STALE_AFTER_MS,
  resolveMachineHealthThreshold,
} from "./machineHealth";

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
  coverage: "full",
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
      t3Coverage: "full",
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

  it("applies valid environment thresholds and rejects an inverted pair", () => {
    expect(
      derive({
        threshold: { attentionPercent: 20, criticalPercent: 30 },
      }).level,
    ).toBe("attention");
    expect(resolveMachineHealthThreshold({ attentionPercent: 95, criticalPercent: 90 })).toEqual({
      attentionPercent: 80,
      criticalPercent: 95,
    });
  });

  it("distinguishes unavailable, failed, and partial collection", () => {
    expect(derive({ connected: false }).level).toBe("unavailable");
    expect(derive({ host: null, failed: true }).level).toBe("error");
    expect(derive({ telemetry: null, telemetryReceivedAt: null }).level).toBe("partial");
    expect(derive({ telemetry: { ...telemetry, status: "degraded" } }).level).toBe("partial");
    expect(
      derive({
        telemetry: {
          ...telemetry,
          status: "unavailable",
          coverage: "server-only",
          currentCpuPercent: null,
        },
      }),
    ).toMatchObject({
      level: "partial",
      t3CpuPercent: null,
      t3MemoryBytes: 1_024,
      t3Coverage: "server-only",
    });
    expect(
      derive({
        host: { ...host, storage: { status: "error", volumes: [] } },
      }).level,
    ).toBe("partial");
  });
});

describe("machine health history", () => {
  it("deduplicates samples, keeps a hard limit, and reports peaks", () => {
    const first = {
      sampledAt: 1,
      hostCpuUtilization: 0.2,
      hostMemoryUtilization: 0.4,
      storageUtilization: null,
    };
    const duplicate = appendMachineHealthHistory([first], { ...first, hostCpuUtilization: 0.9 });
    expect(duplicate).toEqual([first]);

    const history = appendMachineHealthHistory(
      duplicate,
      {
        sampledAt: 2,
        hostCpuUtilization: 0.7,
        hostMemoryUtilization: 0.3,
        storageUtilization: 0.8,
      },
      2,
    );
    const bounded = appendMachineHealthHistory(
      history,
      {
        sampledAt: 3,
        hostCpuUtilization: 0.5,
        hostMemoryUtilization: 0.9,
        storageUtilization: 0.7,
      },
      2,
    );
    expect(bounded.map((point) => point.sampledAt)).toEqual([2, 3]);
    expect(machineHealthHistoryPeaks(bounded)).toEqual({
      hostCpuUtilization: 0.7,
      hostMemoryUtilization: 0.9,
      storageUtilization: 0.8,
    });
  });
});
