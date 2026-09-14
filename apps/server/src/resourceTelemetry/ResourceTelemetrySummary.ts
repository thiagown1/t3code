import type { ResourceTelemetrySnapshot, ResourceTelemetrySummary } from "@t3tools/contracts";

/** Reduce diagnostics to the privacy-safe aggregate needed by machine health. */
export function summarizeResourceTelemetry(
  snapshot: ResourceTelemetrySnapshot,
): ResourceTelemetrySummary {
  return {
    readAt: snapshot.readAt,
    status: snapshot.health.native.status,
    processCount: snapshot.groups.allT3.processCount,
    currentCpuPercent: snapshot.groups.allT3.currentCpuPercent,
    currentRssBytes: snapshot.groups.allT3.currentRssBytes,
  };
}
