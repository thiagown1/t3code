import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { TURN_REVIEW_OPTION_IDS } from "@t3tools/shared/firstMateTurnReview";
import { ArrowUpRightIcon, ShieldAlertIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  completeFirstMateQueueItem,
  deferFirstMateQueueItem,
  EMPTY_FIRST_MATE_QUEUE_CURSOR,
  pinFirstMateQueueItem,
  presentFirstMateQueue,
  type FirstMateQueueCursor,
  type FirstMateQueueItem,
} from "./FirstMateDecisionQueue.logic";
import type { ResolveFirstMateDecisionRequest } from "./FirstMateDecisionInbox";

export interface ReplyToFirstMateThreadRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
}

interface FirstMateDecisionQueueProps {
  readonly queue: ReadonlyArray<FirstMateQueueItem>;
  readonly onResolveDecision: (request: ResolveFirstMateDecisionRequest) => Promise<boolean>;
  readonly onCancelDecision: (
    request: Omit<ResolveFirstMateDecisionRequest, "selectedOptionId">,
  ) => Promise<boolean>;
  readonly onReply: (request: ReplyToFirstMateThreadRequest) => Promise<boolean>;
  readonly onOpenThread: (thread: ScopedThreadRef) => void;
}

const UP_NEXT_LIMIT = 6;

const KIND_LABELS: Record<FirstMateQueueItem["kind"], string> = {
  "provider-request": "Request",
  "turn-review": "Turn review",
  "supervisor-question": "FirstMate",
  "failed-run": "Run",
  "pull-request": "Pull request",
};

const VERDICT_LABELS: Record<NonNullable<FirstMateQueueItem["verdict"]>["outcome"], string> = {
  blocked: "blocked",
  needs_user: "needs you",
  done: "looks done",
  continue: "could continue",
};

/**
 * Everything waiting on the user, one item at a time. The item on screen is
 * pinned: new or more urgent work only reorders the list behind it, and it
 * leaves only when the user answers, sets it aside, or moves on.
 */
export function FirstMateDecisionQueue({
  queue,
  onResolveDecision,
  onCancelDecision,
  onReply,
  onOpenThread,
}: FirstMateDecisionQueueProps) {
  const [cursor, setCursor] = useState<FirstMateQueueCursor>(EMPTY_FIRST_MATE_QUEUE_CURSOR);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const view = presentFirstMateQueue(queue, cursor);
  const current = view.current;

  // Pin whatever is about to be shown, so an arrival cannot replace it.
  if (current !== null && cursor.reading?.key !== current.key) {
    setCursor((value) => pinFirstMateQueueItem(value, current));
  }

  const moveOn = (next: (value: FirstMateQueueCursor) => FirstMateQueueCursor) => {
    setDraft("");
    setCursor(next);
  };

  const act = async (label: string, action: () => Promise<boolean>) => {
    if (current === null || busy !== null) return;
    setBusy(label);
    try {
      if (await action()) moveOn((value) => completeFirstMateQueueItem(value, current.key));
    } finally {
      setBusy(null);
    }
  };

  if (current === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Nothing needs you. FirstMate brings decisions, stuck runs and red checks here.
      </p>
    );
  }

  const decision = current.decision;
  const resolve = (optionId: string) =>
    void act(`option:${optionId}`, () =>
      decision === null
        ? Promise.resolve(false)
        : onResolveDecision({
            environmentId: current.environmentId,
            projectId: current.projectId,
            decisionId: decision.decisionId,
            selectedOptionId: optionId,
          }),
    );

  const reply = () => {
    const text = draft.trim();
    const threadId = current.threadId;
    if (text.length === 0 || threadId === null || !current.canReply) return;
    void act("reply", async () => {
      if (!(await onReply({ environmentId: current.environmentId, threadId, text }))) return false;
      // The reply is the answer: close the card so it cannot come back.
      if (decision === null) return true;
      if (
        decision.sourceKind === "turn-review" &&
        decision.options.some((option) => option.id === TURN_REVIEW_OPTION_IDS.answerMyself)
      ) {
        await onResolveDecision({
          environmentId: current.environmentId,
          projectId: current.projectId,
          decisionId: decision.decisionId,
          selectedOptionId: TURN_REVIEW_OPTION_IDS.answerMyself,
        });
      } else {
        await onCancelDecision({
          environmentId: current.environmentId,
          projectId: current.projectId,
          decisionId: decision.decisionId,
        });
      }
      return true;
    });
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      reply();
    }
  };

  const threadRef =
    current.threadId === null
      ? null
      : { environmentId: current.environmentId, threadId: current.threadId };

  return (
    <div className="space-y-3 p-4">
      <article
        aria-label="Needs your decision"
        className={cn(
          "rounded-lg border p-3",
          decision?.blocking === true ? "border-amber-500/50 bg-amber-500/5" : "bg-card",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium">
            {KIND_LABELS[current.kind]}
          </span>
          <span className="truncate">{current.topicTitle ?? current.threadTitle ?? "Thread"}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{formatRelativeTimeLabel(current.updatedAt)}</span>
          {decision?.blocking === true ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-amber-700 dark:text-amber-300">
              <ShieldAlertIcon aria-hidden className="size-3.5" />
              Blocking
            </span>
          ) : null}
        </div>

        {view.currentGone ? (
          <p
            role="status"
            className="mt-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground"
          >
            Already handled elsewhere.{" "}
            <button
              type="button"
              onClick={() => moveOn((value) => completeFirstMateQueueItem(value, current.key))}
              className="cursor-pointer font-medium text-foreground underline-offset-2 hover:underline"
            >
              Next
            </button>
          </p>
        ) : null}

        <h3 className="mt-2 text-sm font-semibold leading-5">{current.headline}</h3>
        {current.verdict !== null ? (
          <p className="text-xs text-muted-foreground">
            Judge: {VERDICT_LABELS[current.verdict.outcome]} (
            {Math.round(current.verdict.outcomeConfidence * 100)}% sure)
          </p>
        ) : null}

        {current.topicSummary !== null || current.latestRoundSummary !== null ? (
          <dl className="mt-2 space-y-1 text-xs">
            {current.topicSummary !== null ? (
              <div>
                <dt className="inline font-medium">Goal: </dt>
                <dd className="inline text-muted-foreground">{current.topicSummary}</dd>
              </div>
            ) : null}
            {current.latestRoundSummary !== null ? (
              <div>
                <dt className="inline font-medium">Last round: </dt>
                <dd className="inline text-muted-foreground">{current.latestRoundSummary}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {current.detail !== null ? (
          <p className="mt-2 max-h-64 overflow-y-auto rounded-md bg-muted/60 p-2 text-sm leading-5 whitespace-pre-wrap">
            {current.detail}
          </p>
        ) : null}

        {current.pullRequests.length > 0 || threadRef !== null ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {current.pullRequests.map((pullRequest) => (
              <a
                key={pullRequest.key}
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
              >
                #{pullRequest.number}
                {pullRequest.headSha === null ? "" : ` ${pullRequest.headSha.slice(0, 7)}`}
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </a>
            ))}
            {threadRef !== null ? (
              <button
                type="button"
                onClick={() => onOpenThread(threadRef)}
                className="inline-flex cursor-pointer items-center gap-0.5 text-muted-foreground hover:text-foreground"
              >
                Open thread
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </button>
            ) : null}
          </div>
        ) : null}

        {decision !== null && decision.options.length > 0 && !view.currentGone ? (
          <div className="mt-3 grid gap-1.5">
            {decision.options.map((option) => {
              const recommended = option.id === decision.recommendedOptionId;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => resolve(option.id)}
                  className={cn(
                    "cursor-pointer rounded-md border px-2.5 py-1.5 text-left outline-none active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60",
                    recommended ? "border-amber-500/50 bg-amber-500/10" : "hover:bg-accent",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    {busy === `option:${option.id}` ? "Saving…" : option.label}
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
        ) : null}

        {current.canReply && !view.currentGone ? (
          <div className="mt-3">
            <textarea
              aria-label="Reply to the agent"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onDraftKeyDown}
              rows={3}
              placeholder="Reply to the agent… (Ctrl+Enter to send)"
              className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        ) : null}

        <div className="mt-2 flex items-center gap-2">
          {current.canReply && !view.currentGone ? (
            <button
              type="button"
              disabled={busy !== null || draft.trim().length === 0}
              onClick={reply}
              className="cursor-pointer rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
            >
              {busy === "reply" ? "Sending…" : "Send and next"}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => moveOn((value) => deferFirstMateQueueItem(value, current.key))}
            className="cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Later
          </button>
          {decision !== null && !view.currentGone ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void act("dismiss", () =>
                  onCancelDecision({
                    environmentId: current.environmentId,
                    projectId: current.projectId,
                    decisionId: decision.decisionId,
                  }),
                )
              }
              className="ml-auto cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
            </button>
          ) : null}
        </div>
      </article>

      {view.upNext.length > 0 ? (
        <section aria-label="Up next">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            Up next · {view.upNext.length}
          </h3>
          <ol className="space-y-0.5">
            {view.upNext.slice(0, UP_NEXT_LIMIT).map((item) => (
              <li
                key={item.key}
                className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-xs"
              >
                <span className="shrink-0 tabular-nums text-muted-foreground">{item.priority}</span>
                <span className="truncate">{item.headline}</span>
                <span aria-hidden className="text-muted-foreground">
                  ·
                </span>
                <span className="truncate text-muted-foreground">
                  {item.topicTitle ?? item.threadTitle ?? ""}
                </span>
              </li>
            ))}
          </ol>
          {view.upNext.length > UP_NEXT_LIMIT ? (
            <p className="px-1.5 text-xs text-muted-foreground">
              and {view.upNext.length - UP_NEXT_LIMIT} more
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
