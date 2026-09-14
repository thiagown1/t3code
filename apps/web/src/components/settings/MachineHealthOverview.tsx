import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ActivityIcon, CpuIcon, HardDriveIcon, MemoryStickIcon } from "lucide-react";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { cn } from "~/lib/utils";
import {
  appendMachineHealthHistory,
  deriveMachineHealth,
  machineHealthHistoryPeaks,
  resolveMachineHealthThreshold,
  type MachineHealthHistoryPoint,
  type MachineHealthLevel,
} from "~/machineHealth";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const REFRESH_INTERVAL_MS = 10_000;
const ATTENTION_OPTIONS = [60, 70, 75, 80, 85, 90].map((value) => ({
  value,
  label: `${value}%`,
}));
const CRITICAL_OPTIONS = [85, 90, 95, 98, 99].map((value) => ({
  value,
  label: `${value}%`,
}));

const LEVEL_PRESENTATION: Record<
  MachineHealthLevel,
  { readonly label: string; readonly dotClassName: string; readonly textClassName: string }
> = {
  healthy: {
    label: "Healthy",
    dotClassName: "bg-emerald-500",
    textClassName: "text-emerald-700 dark:text-emerald-300",
  },
  attention: {
    label: "Attention",
    dotClassName: "bg-amber-500",
    textClassName: "text-amber-700 dark:text-amber-300",
  },
  critical: {
    label: "Critical",
    dotClassName: "bg-destructive",
    textClassName: "text-destructive",
  },
  partial: {
    label: "Partial data",
    dotClassName: "bg-amber-400",
    textClassName: "text-muted-foreground",
  },
  stale: {
    label: "Stale",
    dotClassName: "bg-amber-400",
    textClassName: "text-muted-foreground",
  },
  loading: {
    label: "Loading",
    dotClassName: "bg-muted-foreground/40",
    textClassName: "text-muted-foreground",
  },
  unavailable: {
    label: "Unavailable",
    dotClassName: "bg-muted-foreground/30",
    textClassName: "text-muted-foreground",
  },
  error: {
    label: "Collector error",
    dotClassName: "bg-destructive",
    textClassName: "text-destructive",
  },
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatRatio(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value * 100)}%`;
}

function formatAge(receivedAt: number | null, now: number): string {
  if (receivedAt === null) return "No sample";
  const seconds = Math.max(0, Math.floor((now - receivedAt) / 1_000));
  if (seconds < 5) return "Now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function Metric(props: {
  readonly icon: typeof CpuIcon;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  const Icon = props.icon;
  return (
    <div className="min-w-0 rounded-xl bg-muted/35 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/70">
        <Icon className="size-3" aria-hidden="true" />
        {props.label}
      </div>
      <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{props.value}</div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{props.detail}</div>
    </div>
  );
}

export function MachineHealthOverview() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const settings = useClientSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();
  const [now, setNow] = useState(() => Date.now());
  const [historyByEnvironment, setHistoryByEnvironment] = useState<
    Readonly<Record<string, ReadonlyArray<MachineHealthHistoryPoint>>>
  >({});
  const targets = useMemo(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        connected: environment.connection.phase === "connected",
      })),
    [environments],
  );
  const rowsAtom = useMemo(
    () =>
      Atom.make((get) =>
        targets.map((target) => {
          if (!target.connected) {
            return {
              ...target,
              host: null,
              telemetry: null,
              hostReceivedAt: null,
              telemetryReceivedAt: null,
              pending: false,
              failed: false,
            };
          }
          const host = get(
            serverEnvironment.hostResources({ environmentId: target.environmentId, input: {} }),
          );
          const telemetry = get(
            serverEnvironment.resourceTelemetrySummary({
              environmentId: target.environmentId,
              input: {},
            }),
          );
          return {
            ...target,
            host: host._tag === "Success" ? host.value : null,
            telemetry: telemetry._tag === "Success" ? telemetry.value : null,
            hostReceivedAt: host._tag === "Success" ? host.timestamp : null,
            telemetryReceivedAt: telemetry._tag === "Success" ? telemetry.timestamp : null,
            pending:
              host._tag === "Initial" ||
              telemetry._tag === "Initial" ||
              host.waiting ||
              telemetry.waiting,
            failed: host._tag === "Failure" || telemetry._tag === "Failure",
          };
        }),
      ),
    [targets],
  );
  const rows = useAtomValue(rowsAtom);
  const healthRows = useMemo(
    () =>
      rows.map((row) => {
        const threshold = resolveMachineHealthThreshold(
          settings.machineHealthThresholds[row.environmentId],
        );
        return {
          ...row,
          threshold,
          health: deriveMachineHealth({ ...row, now, threshold }),
        };
      }),
    [now, rows, settings.machineHealthThresholds],
  );

  const recordCurrentHistory = useCallback(() => {
    setHistoryByEnvironment((current) => {
      const next: Record<string, ReadonlyArray<MachineHealthHistoryPoint>> = {};
      let changed = Object.keys(current).length !== healthRows.length;
      for (const row of healthRows) {
        const previous = current[row.environmentId] ?? [];
        const updated =
          row.hostReceivedAt === null
            ? previous
            : appendMachineHealthHistory(previous, {
                sampledAt: row.hostReceivedAt,
                hostCpuUtilization: row.health.hostCpuUtilization,
                hostMemoryUtilization: row.health.hostMemoryUtilization,
                storageUtilization: row.health.storageUtilization,
              });
        next[row.environmentId] = updated;
        changed ||= updated !== previous;
      }
      return changed ? next : current;
    });
  }, [healthRows]);

  const refresh = useCallback(() => {
    recordCurrentHistory();
    setNow(Date.now());
    for (const target of targets) {
      if (!target.connected) continue;
      registry.refresh(
        serverEnvironment.hostResources({ environmentId: target.environmentId, input: {} }),
      );
    }
  }, [recordCurrentHistory, registry, targets]);

  useEffect(() => {
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const updateThreshold = useCallback(
    (
      environmentId: string,
      current: { readonly attentionPercent: number; readonly criticalPercent: number },
      patch: Partial<{ readonly attentionPercent: number; readonly criticalPercent: number }>,
    ) => {
      updateSettings({
        machineHealthThresholds: {
          ...settings.machineHealthThresholds,
          [environmentId]: { ...current, ...patch },
        },
      });
    },
    [settings.machineHealthThresholds, updateSettings],
  );
  const criticalCount = healthRows.filter((row) => row.health.level === "critical").length;
  const refreshing = healthRows.some((row) => row.pending);

  return (
    <SettingsSection
      {...searchableSetting("machine-health")}
      icon={<ActivityIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {criticalCount > 0
              ? `${criticalCount} critical`
              : `${healthRows.filter((row) => row.connected).length} connected`}
          </span>
          <Button
            type="button"
            size="icon-micro"
            variant="ghost"
            onClick={refresh}
            aria-label="Refresh machine health"
          >
            <RefreshIcon className="size-3" refreshing={refreshing} />
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 lg:grid-cols-2">
        {healthRows.map((row) => {
          const presentation = LEVEL_PRESENTATION[row.health.level];
          const storage = row.host?.storage?.volumes[0] ?? null;
          const memoryUsed = row.host
            ? row.host.totalMemoryBytes - row.host.availableMemoryBytes
            : null;
          const storageUsed = storage ? storage.totalBytes - storage.availableBytes : null;
          const history = historyByEnvironment[row.environmentId] ?? [];
          const peaks = machineHealthHistoryPeaks(history);
          return (
            <div
              key={row.environmentId}
              className={cn(
                "overflow-hidden rounded-2xl border bg-card shadow-[0_1px_1px_rgb(0_0_0/0.03)]",
                row.health.level === "critical" ? "border-destructive/35" : "border-border/70",
              )}
            >
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{row.label}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    Sample {formatAge(row.hostReceivedAt, now)}
                  </div>
                </div>
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
                    presentation.textClassName,
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", presentation.dotClassName)} />
                  {presentation.label}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 p-3">
                <Metric
                  icon={CpuIcon}
                  label="CPU host"
                  value={formatRatio(row.health.hostCpuUtilization)}
                  detail={
                    row.health.t3CpuPercent === null
                      ? "T3 unavailable"
                      : `T3 ${row.health.t3CpuPercent.toFixed(1)}%`
                  }
                />
                <Metric
                  icon={MemoryStickIcon}
                  label="Memory"
                  value={formatRatio(row.health.hostMemoryUtilization)}
                  detail={
                    memoryUsed === null || !row.host
                      ? "Host unavailable"
                      : `${formatBytes(memoryUsed)} used · ${
                          row.health.t3MemoryBytes === null
                            ? "T3 unavailable"
                            : `T3 ${formatBytes(row.health.t3MemoryBytes)}`
                        }`
                  }
                />
                <Metric
                  icon={HardDriveIcon}
                  label="Storage"
                  value={formatRatio(row.health.storageUtilization)}
                  detail={
                    storageUsed === null || storage === null
                      ? row.host?.storage?.status === "error"
                        ? "Collector error"
                        : "Unavailable"
                      : `${formatBytes(storageUsed)} used · ${formatBytes(storage.availableBytes)} free`
                  }
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 text-[10px] text-muted-foreground">
                <span className="tabular-nums">
                  Session peaks ({history.length}): CPU {formatRatio(peaks.hostCpuUtilization)} ·
                  RAM {formatRatio(peaks.hostMemoryUtilization)} · disk{" "}
                  {formatRatio(peaks.storageUtilization)}
                </span>
                <div className="flex items-center gap-1.5">
                  <span>Attention</span>
                  <Select
                    items={ATTENTION_OPTIONS.filter(
                      (option) => option.value < row.threshold.criticalPercent,
                    )}
                    value={row.threshold.attentionPercent}
                    disabled={!settingsHydrated}
                    onValueChange={(attentionPercent) => {
                      if (attentionPercent === null) return;
                      updateThreshold(row.environmentId, row.threshold, { attentionPercent });
                    }}
                  >
                    <SelectTrigger
                      size="xs"
                      className="w-[4.25rem]"
                      aria-label={`${row.label} attention threshold`}
                    >
                      <SelectValue>{row.threshold.attentionPercent}%</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {ATTENTION_OPTIONS.filter(
                        (option) => option.value < row.threshold.criticalPercent,
                      ).map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span>Critical</span>
                  <Select
                    items={CRITICAL_OPTIONS.filter(
                      (option) => option.value > row.threshold.attentionPercent,
                    )}
                    value={row.threshold.criticalPercent}
                    disabled={!settingsHydrated}
                    onValueChange={(criticalPercent) => {
                      if (criticalPercent === null) return;
                      updateThreshold(row.environmentId, row.threshold, { criticalPercent });
                    }}
                  >
                    <SelectTrigger
                      size="xs"
                      className="w-[4.25rem]"
                      aria-label={`${row.label} critical threshold`}
                    >
                      <SelectValue>{row.threshold.criticalPercent}%</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {CRITICAL_OPTIONS.filter(
                        (option) => option.value > row.threshold.attentionPercent,
                      ).map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}
