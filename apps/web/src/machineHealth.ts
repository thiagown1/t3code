import type { HostResourcesSnapshot, ResourceTelemetrySummary } from "@t3tools/contracts";

export const MACHINE_HEALTH_STALE_AFTER_MS = 30_000;

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
}): MachineHealthViewModel {
  const storage = input.host?.storage?.volumes[0] ?? null;
  const hostCpuUtilization = input.host?.cpuUtilization ?? null;
  const hostMemoryUtilization = input.host
    ? utilization(input.host.totalMemoryBytes, input.host.availableMemoryBytes)
    : null;
  const storageUtilization = storage
    ? utilization(storage.totalBytes, storage.availableBytes)
    : null;
  const hasT3Metrics =
    input.telemetry?.status === "healthy" || input.telemetry?.status === "degraded";
  const t3CpuPercent = hasT3Metrics ? input.telemetry.currentCpuPercent : null;
  const t3MemoryBytes = hasT3Metrics ? input.telemetry.currentRssBytes : null;

  const withMetrics = (level: MachineHealthLevel): MachineHealthViewModel => ({
    level,
    hostCpuUtilization,
    hostMemoryUtilization,
    storageUtilization,
    t3CpuPercent,
    t3MemoryBytes,
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
  if (utilizations.some((value) => value >= 0.95)) return withMetrics("critical");
  if (utilizations.some((value) => value >= 0.8)) return withMetrics("attention");
  if (
    input.failed ||
    input.telemetry === null ||
    input.telemetry.status !== "healthy" ||
    input.host.storage === undefined ||
    input.host.storage.status !== "available"
  ) {
    return withMetrics("partial");
  }
  return withMetrics("healthy");
}
