import { Button } from "../ui/button";
import {
  type ContextWindowSnapshot,
  formatContextWindowTokens,
  presentContextWindow,
} from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 text-[11px] leading-4">
      <span className="shrink-0 text-secondary-label">{label}</span>
      <span className="min-w-0 text-right font-medium tabular-nums text-muted-foreground">
        {value}
      </span>
    </div>
  );
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(timestamp))
    : "Not reported";
}

export function ContextWindowDetails(props: {
  readonly usage: ContextWindowSnapshot;
  readonly modelDisplayName?: string | null | undefined;
  readonly providerDisplayName?: string | null | undefined;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled?: boolean | undefined;
  readonly compactDisabledReason?: string | null | undefined;
}) {
  const {
    usage,
    modelDisplayName,
    providerDisplayName,
    onCompact,
    compactDisabled,
    compactDisabledReason,
  } = props;
  const presentation = presentContextWindow(usage);
  const active = `${presentation.activeTokens} / ${presentation.maximumTokens}`;
  const source = providerDisplayName
    ? `${presentation.source} · ${providerDisplayName}`
    : presentation.source;
  return (
    <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Context window</div>
        <div className="text-secondary-label text-[11px] tabular-nums">
          {presentation.usedPercentage}
        </div>
      </div>
      {usage.maxTokens !== null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.max(0, Math.min(100, usage.usedPercentage ?? 0)))}
          aria-label="Context window usage"
        >
          <div
            className="h-full rounded-full bg-muted-foreground transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${Math.max(0, Math.min(100, usage.usedPercentage ?? 0))}%` }}
          />
        </div>
      ) : null}
      <div className="grid gap-1.5 border-border/50 border-t pt-2">
        <DetailRow label="Active context" value={active} />
        <DetailRow label="Used" value={presentation.usedPercentage} />
        <DetailRow label="Total processed" value={presentation.totalProcessedTokens} />
        <DetailRow label="Model" value={modelDisplayName ?? "Not reported"} />
        <DetailRow label="Source" value={source} />
        <div className="flex items-start justify-between gap-4 text-[11px] leading-4">
          <span className="shrink-0 text-secondary-label">Updated</span>
          <time
            dateTime={presentation.updatedAt}
            className="min-w-0 text-right font-medium text-muted-foreground"
          >
            {formatUpdatedAt(presentation.updatedAt)}
          </time>
        </div>
      </div>
      <div className="grid gap-1.5 border-border/50 border-t pt-2">
        <div className="font-medium text-muted-foreground text-[11px]">Last turn</div>
        <DetailRow label="Input" value={presentation.lastInputTokens} />
        <DetailRow label="Cache read" value={presentation.lastCachedInputTokens} />
        <DetailRow label="Output" value={presentation.lastOutputTokens} />
        <DetailRow label="Reasoning" value={presentation.lastReasoningOutputTokens} />
      </div>
      {usage.compactsAutomatically ? (
        <div className="text-pretty text-secondary-label text-[11px] font-medium">
          {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
        </div>
      ) : null}
      {onCompact ? (
        <>
          <Button
            size="xs"
            variant="outline"
            className="mt-1 w-full justify-center"
            disabled={compactDisabled}
            onClick={onCompact}
          >
            <Minimize2Icon aria-hidden="true" />
            Compact context
          </Button>
          {compactDisabled && compactDisabledReason ? (
            <div className="text-pretty text-secondary-label text-[11px]">
              {compactDisabledReason}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null | undefined;
  providerDisplayName?: string | null | undefined;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const {
    usage,
    modelDisplayName,
    providerDisplayName,
    onCompact,
    compactDisabled,
    compactDisabledReason,
  } = props;
  const presentation = presentContextWindow(usage);
  const usedPercentage = presentation.usedPercentage;
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage.maxTokens !== null && usage.usedPercentage !== null
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-80 max-w-none text-left whitespace-normal"
      >
        <ContextWindowDetails
          usage={usage}
          modelDisplayName={modelDisplayName}
          providerDisplayName={providerDisplayName}
          onCompact={onCompact}
          compactDisabled={compactDisabled}
          compactDisabledReason={compactDisabledReason}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** Holds the meter's footprint while a thread's activities are still loading. */
export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
