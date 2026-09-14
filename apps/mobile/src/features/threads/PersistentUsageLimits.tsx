import {
  compactUsageLimitsSummary,
  collectProviderUsageLimits,
  formatCompactUsageLimitsValue,
} from "@t3tools/shared/usageLimits";
import type {
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
  UsageLimitsReport,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

function useNowMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Compact mobile counterpart to the persistent web quota row. */
export function PersistentUsageLimits({
  instanceId,
  providers,
  sources,
  onOpen,
}: {
  readonly instanceId: ProviderInstanceId;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly onOpen: (report: UsageLimitsReport) => void;
}) {
  const now = useNowMinute();
  const report = useMemo(
    () => collectProviderUsageLimits(instanceId, providers, sources, now),
    [instanceId, now, providers, sources],
  );
  const summary = useMemo(
    () => (report === null ? null : compactUsageLimitsSummary(report, now)),
    [now, report],
  );
  if (summary === null) return null;
  const value = formatCompactUsageLimitsValue(summary);
  return (
    <Pressable
      accessibilityLabel="Open usage limits"
      accessibilityRole="button"
      onPress={() => {
        const current = collectProviderUsageLimits(instanceId, providers, sources, Date.now());
        if (current !== null) onOpen(current);
      }}
      className="mx-4 mb-2 flex-row items-center gap-2 rounded-xl border border-border-subtle bg-card px-3 py-2 active:opacity-70"
    >
      <SymbolView
        name="gauge.with.dots.needle.67percent"
        size={14}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
        <Text className="shrink font-medium text-xs text-foreground" numberOfLines={1}>
          {summary.accountLabel}
          {summary.accountCount > 1 ? ` +${summary.accountCount - 1}` : ""}
        </Text>
        <Text className="text-xs text-foreground-muted">·</Text>
        <Text
          className={
            summary.status === "available"
              ? "shrink text-xs text-foreground-muted"
              : "shrink text-xs text-warning"
          }
          numberOfLines={1}
        >
          {value}
        </Text>
      </View>
    </Pressable>
  );
}
