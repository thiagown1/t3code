import { presentContextWindow, type ContextWindowSnapshot } from "@t3tools/shared/contextWindow";

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(timestamp))
    : "Not reported";
}

export function formatContextWindowAlert(props: {
  readonly usage: ContextWindowSnapshot;
  readonly modelDisplayName?: string | null | undefined;
  readonly providerDisplayName?: string | null | undefined;
}): string {
  const presentation = presentContextWindow(props.usage);
  const source = props.providerDisplayName
    ? `${presentation.source} · ${props.providerDisplayName}`
    : presentation.source;

  return [
    `Active context: ${presentation.activeTokens} / ${presentation.maximumTokens}`,
    `Used: ${presentation.usedPercentage}`,
    `Total processed: ${presentation.totalProcessedTokens}`,
    `Model: ${props.modelDisplayName ?? "Not reported"}`,
    `Source: ${source}`,
    `Updated: ${formatUpdatedAt(presentation.updatedAt)}`,
    "",
    "Last turn",
    `Input: ${presentation.lastInputTokens}`,
    `Cache read: ${presentation.lastCachedInputTokens}`,
    `Output: ${presentation.lastOutputTokens}`,
    `Reasoning: ${presentation.lastReasoningOutputTokens}`,
  ].join("\n");
}
