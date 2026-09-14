import type { ResourceTelemetrySnapshot, ResourceTelemetrySummary } from "@t3tools/contracts";

/** Reduce diagnostics to the privacy-safe aggregate needed by machine health. */
export function summarizeResourceTelemetry(
  snapshot: ResourceTelemetrySnapshot,
  options?: { readonly serverRssBytes?: number },
): ResourceTelemetrySummary {
  const aggregate = snapshot.groups.allT3;
  const hasAggregate = aggregate.processCount > 0;
  const serverRssBytes = options?.serverRssBytes ?? process.memoryUsage().rss;
  return {
    readAt: snapshot.readAt,
    status: snapshot.health.native.status,
    coverage:
      snapshot.health.native.status === "healthy"
        ? "full"
        : hasAggregate
          ? "partial"
          : "server-only",
    processCount: hasAggregate ? aggregate.processCount : 1,
    currentCpuPercent: hasAggregate ? aggregate.currentCpuPercent : null,
    currentRssBytes: hasAggregate ? aggregate.currentRssBytes : serverRssBytes,
  };
}
