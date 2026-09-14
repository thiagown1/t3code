import type {
  HostResourcesSnapshot,
  MachineHealthThreshold,
  ResourceTelemetrySummary,
} from "@t3tools/contracts";

export const MACHINE_HEALTH_STALE_AFTER_MS = 30_000;
export const MACHINE_HEALTH_HISTORY_LIMIT = 60;
export const DEFAULT_MACHINE_HEALTH_THRESHOLD = {
  attentionPercent: 80,
  criticalPercent: 95,
} as const satisfies MachineHealthThreshold;

export type MachineHealthLevel =
  | "healthy"
  | "attention"
  | "critical"
  | "partial"
  | "stale"
  | "loading"
  | "unavailable"
  | "error";

export interface MachineHealthViewModel {
  readonly level: MachineHealthLevel;
  readonly hostCpuUtilization: number | null;
  readonly hostMemoryUtilization: number | null;
  readonly storageUtilization: number | null;
  readonly t3CpuPercent: number | null;
  readonly t3MemoryBytes: number | null;
  readonly t3Coverage: ResourceTelemetrySummary["coverage"] | null;
}

export interface MachineHealthHistoryPoint {
  readonly sampledAt: number;
  readonly hostCpuUtilization: number | null;
  readonly hostMemoryUtilization: number | null;
  readonly storageUtilization: number | null;
}

export function resolveMachineHealthThreshold(
  threshold: MachineHealthThreshold | undefined,
): MachineHealthThreshold {
  if (threshold === undefined || threshold.attentionPercent >= threshold.criticalPercent) {
    return DEFAULT_MACHINE_HEALTH_THRESHOLD;
  }
  return threshold;
}

export function appendMachineHealthHistory(
  history: ReadonlyArray<MachineHealthHistoryPoint>,
  point: MachineHealthHistoryPoint,
  limit = MACHINE_HEALTH_HISTORY_LIMIT,
): ReadonlyArray<MachineHealthHistoryPoint> {
  if (limit <= 0 || history.at(-1)?.sampledAt === point.sampledAt) return history;
  return [...history, point].slice(-limit);
}

export function machineHealthHistoryPeaks(
  history: ReadonlyArray<MachineHealthHistoryPoint>,
): Omit<MachineHealthHistoryPoint, "sampledAt"> {
  const peak = (key: Exclude<keyof MachineHealthHistoryPoint, "sampledAt">) => {
    const values = history.flatMap((point) => (point[key] === null ? [] : [point[key]]));
    return values.length === 0 ? null : Math.max(...values);
  };
  return {
    hostCpuUtilization: peak("hostCpuUtilization"),
    hostMemoryUtilization: peak("hostMemoryUtilization"),
    storageUtilization: peak("storageUtilization"),
  };
}

function utilization(total: number, available: number): number | null {
  if (total <= 0 || available < 0) return null;
  return Math.min(1, Math.max(0, (total - available) / total));
}

export function deriveMachineHealth(input: {
  readonly connected: boolean;
  readonly failed: boolean;
  readonly pending: boolean;
  readonly now: number;
  readonly hostReceivedAt: number | null;
  readonly telemetryReceivedAt: number | null;
  readonly host: HostResourcesSnapshot | null;
  readonly telemetry: ResourceTelemetrySummary | null;
  readonly threshold?: MachineHealthThreshold;
}): MachineHealthViewModel {
  const storage = input.host?.storage?.volumes[0] ?? null;
  const hostCpuUtilization = input.host?.cpuUtilization ?? null;
  const hostMemoryUtilization = input.host
    ? utilization(input.host.totalMemoryBytes, input.host.availableMemoryBytes)
    : null;
  const storageUtilization = storage
    ? utilization(storage.totalBytes, storage.availableBytes)
    : null;
  const t3CpuPercent = input.telemetry?.currentCpuPercent ?? null;
  const t3MemoryBytes = input.telemetry?.currentRssBytes ?? null;
  const t3Coverage = input.telemetry?.coverage ?? null;
  const threshold = resolveMachineHealthThreshold(input.threshold);

  const withMetrics = (level: MachineHealthLevel): MachineHealthViewModel => ({
    level,
    hostCpuUtilization,
    hostMemoryUtilization,
    storageUtilization,
    t3CpuPercent,
    t3MemoryBytes,
    t3Coverage,
  });

  if (!input.connected) return withMetrics("unavailable");
  if (!input.host) {
    if (input.failed) return withMetrics("error");
    return withMetrics(input.pending ? "loading" : "unavailable");
  }
  if (
    input.hostReceivedAt === null ||
    input.now - input.hostReceivedAt > MACHINE_HEALTH_STALE_AFTER_MS ||
    (input.telemetryReceivedAt !== null &&
      input.now - input.telemetryReceivedAt > MACHINE_HEALTH_STALE_AFTER_MS)
  ) {
    return withMetrics("stale");
  }

  const utilizations = [hostCpuUtilization, hostMemoryUtilization, storageUtilization].filter(
    (value): value is number => value !== null,
  );
  if (utilizations.some((value) => value * 100 >= threshold.criticalPercent)) {
    return withMetrics("critical");
  }
  if (utilizations.some((value) => value * 100 >= threshold.attentionPercent)) {
    return withMetrics("attention");
  }
  if (
    input.failed ||
    input.telemetry === null ||
    input.telemetry.status !== "healthy" ||
    input.telemetry.coverage !== "full" ||
    input.host.storage === undefined ||
    input.host.storage.status !== "available"
  ) {
    return withMetrics("partial");
  }
  return withMetrics("healthy");
}
