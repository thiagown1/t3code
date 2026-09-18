import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArrowUpRightIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { FirstMateDecisionInboxItem } from "./FirstMateDecisionInbox.logic";
import type { ResolveFirstMateDecisionRequest } from "./FirstMateDecisionInbox";

interface FirstMateDecisionFeedProps {
  readonly items: ReadonlyArray<FirstMateDecisionInboxItem>;
  readonly onResolveDecision: (request: ResolveFirstMateDecisionRequest) => Promise<boolean>;
  readonly onCancelDecision: (
    request: Omit<ResolveFirstMateDecisionRequest, "selectedOptionId">,
  ) => Promise<boolean>;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
}

/**
 * The supervisor chat's answer surface: one card per pending decision, sized
 * for the chat rather than the sidebar, and resolved by clicking an option.
 * Blocking decisions arrive first because the model already sorts them there.
 */
export function FirstMateDecisionFeed({
  items,
  onResolveDecision,
  onCancelDecision,
  onOpenThread,
}: FirstMateDecisionFeedProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (items.length === 0) return null;

  const run = async (key: string, action: () => Promise<boolean>) => {
    setBusyKey(key);
    try {
      await action();
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  return (
    <section
      aria-label="FirstMate decisions"
      className="mb-2 max-h-[min(24rem,45vh)] space-y-2 overflow-y-auto rounded-xl border border-border bg-card/80 p-2 shadow-sm backdrop-blur-sm"
    >
      {items.map((item) => (
        <article
          key={item.key}
          className={cn(
            "rounded-lg border p-3",
            item.blocking ? "border-amber-500/50 bg-amber-500/5" : "border-border bg-background/60",
          )}
        >
          <header className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-sm font-medium leading-5 text-foreground">
              {item.question}
            </p>
            {item.blocking ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                <ShieldAlertIcon aria-hidden className="size-3" />
                Blocking
              </span>
            ) : null}
          </header>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{item.topicTitle}</span>
            {item.responsibleAgentId ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{item.responsibleAgentId}</span>
              </>
            ) : null}
            {item.threadId !== null ? (
              <button
                type="button"
                aria-label={`Open ${item.topicTitle}`}
                onClick={() => {
                  if (item.threadId === null) return;
                  onOpenThread({ environmentId: item.environmentId, threadId: item.threadId });
                }}
                className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open topic
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </button>
            ) : null}
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {item.options.map((option) => {
              const optionKey = `${item.key}:${option.id}`;
              const recommended = option.id === item.recommendedOptionId;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void run(optionKey, () =>
                      onResolveDecision({
                        environmentId: item.environmentId,
                        projectId: item.projectId,
                        decisionId: item.decisionId,
                        selectedOptionId: option.id,
                      }),
                    )
                  }
                  className={cn(
                    "cursor-pointer rounded-md border px-2.5 py-2 text-left outline-none active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60",
                    recommended
                      ? "border-amber-500/50 bg-amber-500/10"
                      : "border-border hover:bg-accent",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    {busyKey === optionKey ? "Saving…" : option.label}
                    {recommended ? (
                      <span className="text-[10px] font-normal text-amber-700 dark:text-amber-300">
                        Recommended
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={busyKey !== null}
            onClick={() =>
              void run(`${item.key}:cancel`, () =>
                onCancelDecision({
                  environmentId: item.environmentId,
                  projectId: item.projectId,
                  decisionId: item.decisionId,
                }),
              )
            }
            className="mt-1.5 cursor-pointer rounded px-1 py-0.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          >
            {busyKey === `${item.key}:cancel` ? "Dismissing…" : "Dismiss without deciding"}
          </button>
        </article>
      ))}
    </section>
  );
}
