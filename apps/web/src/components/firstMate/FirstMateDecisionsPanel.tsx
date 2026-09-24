import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { FirstMateDecision, ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, CompassIcon, XIcon } from "lucide-react";
import { useMemo } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { ResolveFirstMateDecisionRequest } from "./FirstMateDecisionInbox";
import {
  FirstMateDecisionQueue,
  type ReplyToFirstMateThreadRequest,
} from "./FirstMateDecisionQueue";
import { buildFirstMateDecisionQueue } from "./FirstMateDecisionQueue.logic";

const HISTORY_LIMIT = 20;

interface FirstMateDecisionsPanelProps {
  readonly project: EnvironmentProject | undefined;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onResolveDecision: (request: ResolveFirstMateDecisionRequest) => Promise<boolean>;
  readonly onCancelDecision: (
    request: Omit<ResolveFirstMateDecisionRequest, "selectedOptionId">,
  ) => Promise<boolean>;
  readonly onReply: (request: ReplyToFirstMateThreadRequest) => Promise<boolean>;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
}

/**
 * The FirstMate chat's right-hand board: everything in the project waiting on
 * the user, walked one item at a time, then what was recently decided.
 */
export function FirstMateDecisionsPanel({
  project,
  threads,
  onResolveDecision,
  onCancelDecision,
  onReply,
  onOpenThread,
}: FirstMateDecisionsPanelProps) {
  const queue = useMemo(
    () => buildFirstMateDecisionQueue({ project, threads }),
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
        <span className="text-xs tabular-nums text-muted-foreground">
          {queue.length} need{queue.length === 1 ? "s" : ""} you
        </span>
      </header>

      <section aria-label="Needs you">
        <FirstMateDecisionQueue
          queue={queue}
          onResolveDecision={onResolveDecision}
          onCancelDecision={onCancelDecision}
          onReply={onReply}
          onOpenThread={onOpenThread}
        />
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
