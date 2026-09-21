import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  FirstMateDecisionId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronDownIcon, InboxIcon, ShieldAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  buildFirstMateDecisionInboxModel,
  type FirstMateDecisionInboxItem,
} from "./FirstMateDecisionInbox.logic";

export interface ResolveFirstMateDecisionRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly decisionId: FirstMateDecisionId;
  readonly selectedOptionId: string;
}

interface FirstMateDecisionInboxProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly hidden?: boolean;
  readonly onResolveDecision: (request: ResolveFirstMateDecisionRequest) => Promise<boolean>;
  readonly onCancelDecision: (
    request: Omit<ResolveFirstMateDecisionRequest, "selectedOptionId">,
  ) => Promise<boolean>;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
}

export function FirstMateDecisionInbox({
  projects,
  threads,
  scopedProjectKeys,
  hidden = false,
  onResolveDecision,
  onCancelDecision,
  onOpenThread,
}: FirstMateDecisionInboxProps) {
  const [expanded, setExpanded] = useState(true);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const model = useMemo(
    () => buildFirstMateDecisionInboxModel({ projects, threads, scopedProjectKeys }),
    [projects, scopedProjectKeys, threads],
  );

  if (hidden || model.items.length === 0) return null;

  const resolveOption = async (item: FirstMateDecisionInboxItem, selectedOptionId: string) => {
    const key = `${item.key}:${selectedOptionId}`;
    setResolvingKey(key);
    try {
      await onResolveDecision({
        environmentId: item.environmentId,
        projectId: item.projectId,
        decisionId: item.decisionId,
        selectedOptionId,
      });
    } finally {
      setResolvingKey((current) => (current === key ? null : current));
    }
  };

  const cancelDecision = async (item: FirstMateDecisionInboxItem) => {
    const key = `${item.key}:cancel`;
    setResolvingKey(key);
    try {
      await onCancelDecision({
        environmentId: item.environmentId,
        projectId: item.projectId,
        decisionId: item.decisionId,
      });
    } finally {
      setResolvingKey((current) => (current === key ? null : current));
    }
  };

  return (
    <section
      aria-label="FirstMate decisions"
      className="border-b border-sidebar-border/70 px-[calc(var(--sidebar-content-inset)+1px)] pb-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground outline-none active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <InboxIcon aria-hidden className="size-3.5 text-amber-500" />
        <span className="flex-1">Decisions</span>
        <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold tabular-nums text-amber-700 dark:text-amber-300">
          {model.items.length}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 text-sidebar-muted-foreground", !expanded && "-rotate-90")}
        />
      </button>

      {expanded ? (
        <ul aria-live="polite" className="max-h-72 space-y-1 overflow-y-auto px-1">
          {model.items.map((item) => (
            <li
              key={item.key}
              className="rounded-md border border-sidebar-border/80 bg-sidebar-accent/30 p-2"
            >
              <div className="flex items-start gap-1.5">
                <p className="min-w-0 flex-1 text-[11px] font-medium leading-4 text-sidebar-foreground">
                  {item.question}
                </p>
                {item.threadId !== null ? (
                  <button
                    type="button"
                    aria-label={`Open ${item.originTitle}`}
                    onClick={() => {
                      if (item.threadId === null) return;
                      onOpenThread({ environmentId: item.environmentId, threadId: item.threadId });
                    }}
                    className="shrink-0 cursor-pointer rounded p-0.5 text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    <ArrowUpRightIcon aria-hidden className="size-3.5" />
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={resolvingKey !== null}
                  onClick={() => void cancelDecision(item)}
                  className="shrink-0 cursor-pointer rounded px-1 py-0.5 text-[9px] text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-60"
                >
                  {resolvingKey === `${item.key}:cancel` ? "Cancelling…" : "Cancel"}
                </button>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-sidebar-muted-foreground">
                <span className="truncate">{item.originTitle}</span>
                {item.responsibleAgentId ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="truncate">{item.responsibleAgentId}</span>
                  </>
                ) : null}
                {model.projectCount > 1 ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="truncate">{item.projectTitle}</span>
                  </>
                ) : null}
                {item.blocking ? (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-amber-700 dark:text-amber-300">
                    <ShieldAlertIcon aria-hidden className="size-3" />
                    Blocking
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 space-y-1">
                {item.options.map((option) => {
                  const optionKey = `${item.key}:${option.id}`;
                  const recommended = option.id === item.recommendedOptionId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={resolvingKey !== null}
                      onClick={() => void resolveOption(item, option.id)}
                      className={cn(
                        "block w-full cursor-pointer rounded border px-2 py-1 text-left outline-none active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-60",
                        recommended
                          ? "border-amber-500/40 bg-amber-500/10"
                          : "border-sidebar-border/70 hover:bg-sidebar-row-hover",
                      )}
                    >
                      <span className="flex items-center gap-1 text-[10px] font-medium text-sidebar-foreground">
                        {resolvingKey === optionKey ? "Saving…" : option.label}
                        {recommended ? (
                          <span className="text-[9px] font-normal text-amber-700 dark:text-amber-300">
                            Recommended
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-[9px] leading-3.5 text-sidebar-muted-foreground">
                        {option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
