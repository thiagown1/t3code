import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  FirstMateTopicId,
  FirstMateRoutingEvaluationMode,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArchiveIcon,
  ChevronDownIcon,
  CircleDotIcon,
  CompassIcon,
  GitPullRequestIcon,
  Layers3Icon,
  MessageCircleQuestionIcon,
  RocketIcon,
  Unlink2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  buildFirstMatePanelModel,
  linkableSupervisorThread,
  type LinkableSupervisorThread,
  FIRST_MATE_STATUS_LABELS,
  type FirstMatePanelItem,
  type FirstMatePanelSupervisor,
} from "./FirstMateTopicsPanel.logic";

export interface SelectFirstMateTopicRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly topicId: FirstMateTopicId;
}

export interface SetFirstMateRoutingEvaluationModeRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly mode: FirstMateRoutingEvaluationMode;
}

export interface UnlinkFirstMateSupervisorRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

interface FirstMateTopicsPanelProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly hidden?: boolean;
  readonly onUnlinkSupervisor: (request: UnlinkFirstMateSupervisorRequest) => Promise<boolean>;
  readonly onSelectTopic: (request: SelectFirstMateTopicRequest) => Promise<boolean>;
  readonly onSetRoutingEvaluationMode: (
    request: SetFirstMateRoutingEvaluationModeRequest,
  ) => Promise<boolean>;
  readonly onSetWaitingDeploy: (thread: ScopedThreadRef) => Promise<boolean>;
  readonly onArchiveThread: (thread: ScopedThreadRef) => Promise<boolean>;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
  /** The thread the user is looking at, so the panel can offer to adopt it. */
  readonly activeThread?: LinkableSupervisorThread | undefined;
  readonly onLinkSupervisor: (request: LinkFirstMateSupervisorRequest) => Promise<boolean>;
}

export interface LinkFirstMateSupervisorRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
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
    case "ready-to-merge":
      return "bg-emerald-500";
    case "completed":
      return "bg-emerald-500";
    case "monitoring":
      return "bg-cyan-500";
    default:
      return "bg-sky-500";
  }
}

const PULL_REQUEST_STATUS_LABELS: Record<
  FirstMatePanelItem["pullRequests"][number]["status"],
  string
> = {
  syncing: "Syncing",
  stale: "Stale",
  "waiting-ci": "Checks running",
  "action-required": "Action required",
  failing: "Checks failed",
  inconclusive: "Checks inconclusive",
  draft: "Draft",
  conflicting: "Conflicts",
  "ready-to-merge": "Ready to merge",
  merged: "Merged",
  closed: "Closed",
  "checks-unavailable": "Checks unavailable",
};

function pullRequestDescription(pullRequest: FirstMatePanelItem["pullRequests"][number]): string {
  return `${pullRequest.repository}#${pullRequest.number}${pullRequest.headSha === null ? "" : ` at ${pullRequest.headSha}`}: ${PULL_REQUEST_STATUS_LABELS[pullRequest.status]}`;
}

export function FirstMateTopicsPanel({
  projects,
  threads,
  scopedProjectKeys,
  hidden = false,
  onUnlinkSupervisor,
  onSelectTopic,
  onSetRoutingEvaluationMode,
  onSetWaitingDeploy,
  onArchiveThread,
  onOpenThread,
  activeThread,
  onLinkSupervisor,
}: FirstMateTopicsPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [linkingSupervisor, setLinkingSupervisor] = useState(false);
  const [unlinkingKey, setUnlinkingKey] = useState<string | null>(null);
  const [selectingKey, setSelectingKey] = useState<string | null>(null);
  const [settingRoutingEvaluation, setSettingRoutingEvaluation] = useState(false);
  const [actingKey, setActingKey] = useState<string | null>(null);
  const model = useMemo(
    () => buildFirstMatePanelModel({ projects, threads, scopedProjectKeys }),
    [projects, scopedProjectKeys, threads],
  );

  if (hidden || projects.length === 0) return null;

  const linkableSupervisor = linkableSupervisorThread({
    projects,
    activeThread,
    availability: model.availability,
  });

  const linkSupervisor = async (target: LinkableSupervisorThread) => {
    setLinkingSupervisor(true);
    try {
      await onLinkSupervisor({
        environmentId: target.environmentId,
        projectId: target.projectId,
        threadId: target.threadId,
      });
    } finally {
      setLinkingSupervisor(false);
    }
  };

  const selectTopic = async (item: FirstMatePanelItem) => {
    setSelectingKey(item.key);
    try {
      await onSelectTopic({
        environmentId: item.environmentId,
        projectId: item.projectId,
        topicId: item.topicId,
      });
    } finally {
      setSelectingKey((current) => (current === item.key ? null : current));
    }
  };

  const unlinkSupervisor = async (supervisor: FirstMatePanelSupervisor) => {
    setUnlinkingKey(supervisor.key);
    try {
      await onUnlinkSupervisor({
        environmentId: supervisor.environmentId,
        projectId: supervisor.projectId,
      });
    } finally {
      setUnlinkingKey((current) => (current === supervisor.key ? null : current));
    }
  };

  const toggleRoutingEvaluation = async () => {
    if (model.routingEvaluation === null || settingRoutingEvaluation) return;
    setSettingRoutingEvaluation(true);
    try {
      await onSetRoutingEvaluationMode({
        environmentId: model.routingEvaluation.environmentId,
        projectId: model.routingEvaluation.projectId,
        mode: model.routingEvaluation.mode === "off" ? "shadow" : "off",
      });
    } finally {
      setSettingRoutingEvaluation(false);
    }
  };

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
        <>
          {model.supervisors.length > 0 ? (
            <ul aria-label="FirstMate supervisor threads" className="mb-1 space-y-0.5">
              {model.supervisors.map((supervisor) => (
                <li key={supervisor.key} className="flex items-stretch gap-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      onOpenThread({
                        environmentId: supervisor.environmentId,
                        threadId: supervisor.threadId,
                      })
                    }
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none active:scale-[0.99] hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    <CompassIcon aria-hidden className="size-3.5 shrink-0 text-sky-500" />
                    <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground">
                      {supervisor.threadTitle ?? "Supervisor thread unavailable"}
                    </span>
                    <span className="shrink-0 text-[10px] text-sidebar-muted-foreground">
                      {model.projectCount > 1 ? supervisor.projectTitle : "Supervisor"}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Stop using this thread as the FirstMate supervisor for ${supervisor.projectTitle}`}
                    disabled={unlinkingKey !== null}
                    onClick={() => void unlinkSupervisor(supervisor)}
                    className="my-0.5 flex w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-50"
                  >
                    <Unlink2Icon aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : model.availability === "unavailable" ? null : (
            // Telling someone to run a command without giving them a way to run
            // it leaves FirstMate unreachable for anyone who does not already
            // know it lives in the command palette.
            <div className="px-2 pb-1">
              <p className="text-[10px] leading-4 text-sidebar-muted-foreground">
                No supervisor thread yet. FirstMate plans and routes from one thread per project.
              </p>
              {linkableSupervisor === null ? (
                <p className="mt-0.5 text-[10px] leading-4 text-sidebar-muted-foreground/80">
                  Open the thread you want to plan in, then use this button.
                </p>
              ) : (
                <button
                  type="button"
                  disabled={linkingSupervisor}
                  onClick={() => void linkSupervisor(linkableSupervisor)}
                  className="mt-1 cursor-pointer rounded-md px-1.5 py-0.5 text-[10px] leading-4 text-sky-500 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:opacity-60"
                >
                  {linkingSupervisor
                    ? "Linking…"
                    : `Use “${linkableSupervisor.threadTitle}” as supervisor`}
                </button>
              )}
            </div>
          )}
          {model.availability === "ready" ? (
            <ul aria-live="polite" className="max-h-56 space-y-0.5 overflow-y-auto">
              {model.items.map((item) => (
                <li key={item.key} className="flex items-stretch gap-0.5">
                  <button
                    type="button"
                    disabled={item.threadId === null}
                    onClick={() => {
                      if (item.threadId === null) return;
                      onOpenThread({ environmentId: item.environmentId, threadId: item.threadId });
                    }}
                    className={cn(
                      "group flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none active:scale-[0.99] hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:hover:bg-transparent",
                      item.selected && "bg-sidebar-accent/60",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        statusTone(item.status),
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-sidebar-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-[10px] leading-4 text-sidebar-muted-foreground/80">
                        {item.summary}
                      </span>
                      {item.pullRequests.map((pullRequest) => (
                        <Tooltip key={pullRequest.key}>
                          <TooltipTrigger
                            aria-label={pullRequestDescription(pullRequest)}
                            render={
                              <span className="flex min-w-0 items-center gap-1 text-[10px] leading-4 text-sidebar-muted-foreground" />
                            }
                          >
                            <GitPullRequestIcon aria-hidden className="size-2.5 shrink-0" />
                            <span className="shrink-0">#{pullRequest.number}</span>
                            {pullRequest.headSha === null ? null : (
                              <span className="shrink-0 font-mono">
                                {pullRequest.headSha.slice(0, 7)}
                              </span>
                            )}
                            <span aria-hidden>·</span>
                            <span className="truncate">
                              {PULL_REQUEST_STATUS_LABELS[pullRequest.status]}
                            </span>
                          </TooltipTrigger>
                          <TooltipPopup>{pullRequestDescription(pullRequest)}</TooltipPopup>
                        </Tooltip>
                      ))}
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-sidebar-muted-foreground">
                        {/* A topic nobody delegated has no thread to open, so its
                            row is inert. Saying so beats showing a stage label
                            that makes the row look like every clickable one. */}
                        <span className="truncate">
                          {item.threadId === null
                            ? "Not delegated yet"
                            : FIRST_MATE_STATUS_LABELS[item.status]}
                        </span>
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
                  {item.postMergeActionRequired && item.threadId !== null ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Mark ${item.title} as waiting to deploy`}
                        disabled={actingKey !== null}
                        onClick={() => {
                          setActingKey(item.key);
                          void onSetWaitingDeploy({
                            environmentId: item.environmentId,
                            threadId: item.threadId!,
                          }).finally(() => setActingKey(null));
                        }}
                        className="my-1 flex w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-violet-500 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-50"
                      >
                        <RocketIcon aria-hidden className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Archive ${item.title}`}
                        disabled={actingKey !== null}
                        onClick={() => {
                          setActingKey(item.key);
                          void onArchiveThread({
                            environmentId: item.environmentId,
                            threadId: item.threadId!,
                          }).finally(() => setActingKey(null));
                        }}
                        className="my-1 flex w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-50"
                      >
                        <ArchiveIcon aria-hidden className="size-3.5" />
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    aria-label={
                      item.selected
                        ? `${item.title} is the active topic`
                        : `Use ${item.title} as active topic`
                    }
                    aria-pressed={item.selected}
                    disabled={item.threadId === null || item.selected || selectingKey !== null}
                    onClick={() => void selectTopic(item)}
                    className="my-1 flex w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:opacity-50"
                  >
                    <CircleDotIcon
                      aria-hidden
                      className={cn("size-3.5", item.selected && "text-sky-500")}
                    />
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
          )}
          {model.routingEvaluation ? (
            <button
              type="button"
              aria-pressed={model.routingEvaluation.mode === "shadow"}
              disabled={settingRoutingEvaluation}
              onClick={() => void toggleRoutingEvaluation()}
              className="mt-1 w-full cursor-pointer rounded-md px-2 py-1 text-left text-[10px] text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-50"
            >
              Automatic routing evaluation:{" "}
              {model.routingEvaluation.mode === "shadow" ? "Shadow" : "Off"}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
