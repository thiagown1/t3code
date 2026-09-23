import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { FirstMateDecision, ScopedThreadRef } from "@t3tools/contracts";
import { ArrowUpRightIcon, CheckIcon, CompassIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  buildFirstMateDecisionInboxModel,
  type FirstMateDecisionInboxItem,
} from "./FirstMateDecisionInbox.logic";
import type { ResolveFirstMateDecisionRequest } from "./FirstMateDecisionInbox";

const HISTORY_LIMIT = 20;

interface FirstMateDecisionsPanelProps {
  readonly project: EnvironmentProject | undefined;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onResolveDecision: (request: ResolveFirstMateDecisionRequest) => Promise<boolean>;
  readonly onCancelDecision: (
    request: Omit<ResolveFirstMateDecisionRequest, "selectedOptionId">,
  ) => Promise<boolean>;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
}

/**
 * The FirstMate chat's right-hand board: every pending decision for the
 * project in full detail, then what was recently decided.
 */
export function FirstMateDecisionsPanel({
  project,
  threads,
  onResolveDecision,
  onCancelDecision,
  onOpenThread,
}: FirstMateDecisionsPanelProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const pending = useMemo(
    () =>
      project
        ? buildFirstMateDecisionInboxModel({
            projects: [project],
            threads,
            scopedProjectKeys: null,
          }).items
        : [],
    [project, threads],
  );
  const history = useMemo(
    () =>
      (project?.firstMate?.decisions ?? [])
        .filter((decision) => decision.status !== "pending")
        .toSorted((left, right) =>
          (right.resolvedAt ?? right.updatedAt).localeCompare(left.resolvedAt ?? left.updatedAt),
        )
        .slice(0, HISTORY_LIMIT),
    [project],
  );

  const run = async (key: string, action: () => Promise<boolean>) => {
    setBusyKey(key);
    try {
      await action();
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  if (!project?.firstMate) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This project has no FirstMate workspace yet.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <CompassIcon aria-hidden className="size-4 text-sky-500" />
        <h2 className="flex-1 text-sm font-semibold">Decisions</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{pending.length} pending</span>
      </header>

      <section aria-label="Pending decisions" className="space-y-3 p-4">
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to decide. FirstMate will bring questions here as work comes in.
          </p>
        ) : (
          pending.map((item) => (
            <PendingDecisionCard
              key={item.key}
              item={item}
              busyKey={busyKey}
              onOpenThread={onOpenThread}
              onResolve={(optionId) =>
                void run(`${item.key}:${optionId}`, () =>
                  onResolveDecision({
                    environmentId: item.environmentId,
                    projectId: item.projectId,
                    decisionId: item.decisionId,
                    selectedOptionId: optionId,
                  }),
                )
              }
              onCancel={() =>
                void run(`${item.key}:cancel`, () =>
                  onCancelDecision({
                    environmentId: item.environmentId,
                    projectId: item.projectId,
                    decisionId: item.decisionId,
                  }),
                )
              }
            />
          ))
        )}
      </section>

      {history.length > 0 ? (
        <section aria-label="Recent decisions" className="border-t p-4">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Recently decided</h3>
          <ul className="space-y-2">
            {history.map((decision) => (
              <DecidedRow key={decision.id} decision={decision} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function PendingDecisionCard({
  item,
  busyKey,
  onOpenThread,
  onResolve,
  onCancel,
}: {
  readonly item: FirstMateDecisionInboxItem;
  readonly busyKey: string | null;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
  readonly onResolve: (optionId: string) => void;
  readonly onCancel: () => void;
}) {
  const busy = busyKey !== null;
  return (
    <article className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{item.originTitle}</span>
        {item.responsibleAgentId ? (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{item.responsibleAgentId}</span>
          </>
        ) : null}
        <span aria-hidden>·</span>
        <span className="shrink-0">{formatRelativeTimeLabel(item.updatedAt)}</span>
        {item.blocking ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-amber-700 dark:text-amber-300">
            <ShieldAlertIcon aria-hidden className="size-3.5" />
            Blocking
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-sm font-medium leading-5 whitespace-pre-wrap">{item.question}</p>

      <div className="mt-3 space-y-2">
        {item.options.map((option) => {
          const recommended = option.id === item.recommendedOptionId;
          return (
            <button
              key={option.id}
              type="button"
              disabled={busy}
              onClick={() => onResolve(option.id)}
              className={cn(
                "block w-full cursor-pointer rounded-md border px-3 py-2 text-left outline-none active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60",
                recommended ? "border-amber-500/50 bg-amber-500/10" : "hover:bg-accent",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {busyKey === `${item.key}:${option.id}` ? "Saving…" : option.label}
                {recommended ? (
                  <span className="text-xs font-normal text-amber-700 dark:text-amber-300">
                    Recommended
                  </span>
                ) : null}
              </span>
              {option.description ? (
                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground whitespace-pre-wrap">
                  {option.description}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {item.threadId !== null ? (
          <button
            type="button"
            onClick={() => {
              if (item.threadId !== null)
                onOpenThread({ environmentId: item.environmentId, threadId: item.threadId });
            }}
            className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowUpRightIcon aria-hidden className="size-3.5" />
            Open thread
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="ml-auto cursor-pointer rounded px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
        >
          {busyKey === `${item.key}:cancel` ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
    </article>
  );
}

function DecidedRow({ decision }: { readonly decision: FirstMateDecision }) {
  const chosen = decision.options.find((option) => option.id === decision.selectedOptionId);
  const resolved = decision.status === "resolved";
  return (
    <li className="flex items-start gap-2 text-xs">
      {resolved ? (
        <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
      ) : (
        <XIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{decision.question}</span>
        <span className="block truncate text-muted-foreground">
          {resolved ? (chosen?.label ?? "Resolved") : "Dismissed"} ·{" "}
          {formatRelativeTimeLabel(decision.resolvedAt ?? decision.updatedAt)}
        </span>
      </span>
    </li>
  );
}
