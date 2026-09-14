import {
  formatCompactUsageLimitsValue,
  type CompactUsageLimitsSummary,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";

import { ComposerBanner } from "./ComposerBanner";

/** The active provider account's current quota, kept visible above the composer. */
export function PersistentUsageLimits({
  summary,
  onOpen,
}: {
  readonly summary: CompactUsageLimitsSummary;
  readonly onOpen: () => void;
}) {
  const accountSuffix = summary.accountCount > 1 ? ` +${summary.accountCount - 1}` : "";
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-testid="persistent-usage-limits">
        <ComposerBanner.Row
          render={<button type="button" aria-label="Open usage limits" onClick={onOpen} />}
        >
          <ComposerBanner.Icon>
            <GaugeIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="overflow-hidden">
            <span className="max-w-48 truncate font-medium text-foreground">
              {summary.accountLabel}
              {accountSuffix}
            </span>
            <ComposerBanner.Separator />
            <span
              className={
                summary.status === "available"
                  ? "truncate tabular-nums text-muted-foreground"
                  : "truncate text-warning"
              }
            >
              {formatCompactUsageLimitsValue(summary)}
            </span>
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
