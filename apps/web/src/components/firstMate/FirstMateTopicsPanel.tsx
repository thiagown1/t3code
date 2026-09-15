import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, Layers3Icon, MessageCircleQuestionIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  buildFirstMatePanelModel,
  FIRST_MATE_STATUS_LABELS,
  type FirstMatePanelItem,
} from "./FirstMateTopicsPanel.logic";

interface FirstMateTopicsPanelProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly hidden?: boolean;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
}

const topicDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function statusTone(status: FirstMatePanelItem["status"]): string {
  switch (status) {
    case "waiting-user":
      return "bg-amber-500";
    case "blocked":
      return "bg-destructive";
    case "waiting-deploy":
    case "validating-deploy":
    case "waiting-activation":
      return "bg-violet-500";
    case "completed":
      return "bg-emerald-500";
    case "monitoring":
      return "bg-cyan-500";
    default:
      return "bg-sky-500";
  }
}

export function FirstMateTopicsPanel({
  projects,
  threads,
  scopedProjectKeys,
  hidden = false,
  onOpenThread,
}: FirstMateTopicsPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const model = useMemo(
    () => buildFirstMatePanelModel({ projects, threads, scopedProjectKeys }),
    [projects, scopedProjectKeys, threads],
  );

  if (hidden || projects.length === 0) return null;

  return (
    <section
      aria-label="FirstMate topics"
      className="border-b border-sidebar-border/70 px-[calc(var(--sidebar-content-inset)+1px)] pb-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground outline-none active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <Layers3Icon aria-hidden className="size-3.5 text-sidebar-muted-foreground" />
        <span className="flex-1">FirstMate</span>
        {model.availability === "ready" ? (
          <span className="tabular-nums text-[10px] text-sidebar-muted-foreground">
            {model.items.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 text-sidebar-muted-foreground", !expanded && "-rotate-90")}
        />
      </button>

      {expanded ? (
        model.availability === "ready" ? (
          <ul aria-live="polite" className="max-h-56 space-y-0.5 overflow-y-auto">
            {model.items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  disabled={item.threadId === null}
                  onClick={() => {
                    if (item.threadId === null) return;
                    onOpenThread({ environmentId: item.environmentId, threadId: item.threadId });
                  }}
                  className="group flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none active:scale-[0.99] hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span
                    aria-hidden
                    className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", statusTone(item.status))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-sidebar-foreground">
                      {item.title}
                    </span>
                    <span className="block truncate text-[10px] leading-4 text-sidebar-muted-foreground/80">
                      {item.summary}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-sidebar-muted-foreground">
                      <span className="truncate">{FIRST_MATE_STATUS_LABELS[item.status]}</span>
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
                      {item.pendingDecisionCount > 0 ? (
                        <span
                          className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-amber-600 dark:text-amber-400"
                          aria-label={`${item.pendingDecisionCount} pending decision${item.pendingDecisionCount === 1 ? "" : "s"}`}
                        >
                          <MessageCircleQuestionIcon aria-hidden className="size-3" />
                          {item.pendingDecisionCount}
                        </span>
                      ) : null}
                      <time
                        dateTime={item.updatedAt}
                        className={cn(
                          "shrink-0 tabular-nums",
                          item.pendingDecisionCount === 0 && "ml-auto",
                        )}
                      >
                        {topicDateFormatter.format(new Date(item.updatedAt))}
                      </time>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p
            role="status"
            className="px-2 pb-1 pt-0.5 text-[11px] leading-4 text-sidebar-muted-foreground"
          >
            {model.availability === "empty"
              ? "No topics yet. FirstMate will keep active work here."
              : "FirstMate is unavailable in this environment."}
          </p>
        )
      ) : null}
    </section>
  );
}
