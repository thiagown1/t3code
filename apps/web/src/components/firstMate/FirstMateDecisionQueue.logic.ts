import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  FirstMateDecision,
  FirstMateDecisionId,
  FirstMateTurnReviewVerdict,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { buildFirstMateDecisionInboxModel } from "./FirstMateDecisionInbox.logic";
import {
  firstMatePanelPullRequests,
  type FirstMatePanelPullRequest,
} from "./FirstMateTopicsPanel.logic";

/**
 * Everything in one FirstMate project that is waiting on the user, as one
 * ranked queue the Decisions panel walks one item at a time.
 *
 * - `provider-request`: an agent is paused mid-turn on an approval or a
 *   question (a card, or a thread flag with no card yet).
 * - `turn-review`: the turn judge (Jev or a cheap model) could not settle a
 *   finished turn and asked the user.
 * - `supervisor-question`: a decision the FirstMate supervisor opened.
 * - `failed-run`: a delegated thread's session ended in error or was
 *   interrupted.
 * - `pull-request`: a delegated thread's PR has failing, action-required or
 *   conflicting checks.
 */
export type FirstMateQueueItemKind =
  | "provider-request"
  | "turn-review"
  | "supervisor-question"
  | "failed-run"
  | "pull-request";

export interface FirstMateQueueDecision {
  readonly decisionId: FirstMateDecisionId;
  readonly sourceKind: FirstMateDecision["source"]["kind"];
  readonly options: FirstMateDecision["options"];
  readonly recommendedOptionId: string | null;
  readonly blocking: boolean;
}

export interface FirstMateQueueItem {
  readonly key: string;
  readonly kind: FirstMateQueueItemKind;
  readonly priority: number;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The thread a reply goes to, or null when nothing can receive one. */
  readonly threadId: ThreadId | null;
  readonly threadTitle: string | null;
  readonly topicTitle: string | null;
  /** What the topic must achieve, as its author wrote it. */
  readonly topicSummary: string | null;
  /** What the thread's latest finished round produced. */
  readonly latestRoundSummary: string | null;
  /** One line naming what needs deciding. */
  readonly headline: string;
  /** The full question, or the tail of the agent's last message. */
  readonly detail: string | null;
  readonly decision: FirstMateQueueDecision | null;
  readonly verdict: FirstMateTurnReviewVerdict | null;
  readonly pullRequests: ReadonlyArray<FirstMatePanelPullRequest>;
  /** Replying from the queue would reach the agent. */
  readonly canReply: boolean;
  readonly updatedAt: string;
}

/**
 * Queue priority. Higher goes first; equal priorities put the newer item first.
 *
 *   provider request            100   an agent is stopped mid-turn on it
 *   turn review, blocked         90 + 10 × confidence
 *   turn review, needs_user      80 + 10 × confidence
 *   supervisor question          70 blocking, 40 otherwise
 *   failed run                   65
 *   PR checks failing            60
 *   PR action required           55
 *   PR conflicting               50
 *   turn review, done/continue   30   the judge leaned towards acting alone
 *
 * A turn review stored without a verdict ranks as needs_user at confidence 0
 * when blocking, else as done/continue.
 */
export function firstMateQueuePriority(input: {
  readonly kind: FirstMateQueueItemKind;
  readonly blocking?: boolean;
  readonly verdict?: FirstMateTurnReviewVerdict | null;
  readonly pullRequestStatus?: FirstMatePanelPullRequest["status"];
}): number {
  switch (input.kind) {
    case "provider-request":
      return 100;
    case "turn-review": {
      const verdict = input.verdict ?? null;
      if (verdict === null) return input.blocking === true ? 80 : 30;
      const confidence = Math.round(Math.min(1, Math.max(0, verdict.outcomeConfidence)) * 10);
      if (verdict.outcome === "blocked") return 90 + confidence;
      if (verdict.outcome === "needs_user") return 80 + confidence;
      return 30;
    }
    case "supervisor-question":
      return input.blocking === true ? 70 : 40;
    case "failed-run":
      return 65;
    case "pull-request":
      return input.pullRequestStatus === "failing"
        ? 60
        : input.pullRequestStatus === "action-required"
          ? 55
          : 50;
  }
}

const ATTENTION_PULL_REQUEST_STATUSES: ReadonlySet<FirstMatePanelPullRequest["status"]> = new Set([
  "failing",
  "action-required",
  "conflicting",
]);

const PULL_REQUEST_HEADLINES: Partial<Record<FirstMatePanelPullRequest["status"], string>> = {
  failing: "Checks failed",
  "action-required": "Action required",
  conflicting: "Merge conflicts",
};

function isRunning(thread: EnvironmentThreadShell | null): boolean {
  return thread?.session?.status === "running" || thread?.session?.status === "starting";
}

function compareQueueItems(left: FirstMateQueueItem, right: FirstMateQueueItem): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  const recency = right.updatedAt.localeCompare(left.updatedAt);
  return recency !== 0 ? recency : left.key.localeCompare(right.key);
}

export function buildFirstMateDecisionQueue(input: {
  readonly project: EnvironmentProject | null | undefined;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly nowMs?: number;
}): ReadonlyArray<FirstMateQueueItem> {
  const project = input.project;
  const workspace = project?.firstMate;
  if (project == null || workspace == null) return [];
  const nowMs = input.nowMs ?? Date.now();
  const threadByKey = new Map(
    input.threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
  );
  const threadOf = (threadId: ThreadId | null) =>
    threadId === null ? null : (threadByKey.get(`${project.environmentId}:${threadId}`) ?? null);
  const topicByThreadId = new Map(
    workspace.topics.flatMap((topic) =>
      topic.threadId === null ? [] : [[topic.threadId, topic] as const],
    ),
  );
  const topicById = new Map(workspace.topics.map((topic) => [topic.id, topic] as const));

  const items: FirstMateQueueItem[] = [];
  const threadsWithProviderCard = new Set<ThreadId>();

  const { items: decisions } = buildFirstMateDecisionInboxModel({
    projects: [project],
    threads: input.threads,
    scopedProjectKeys: null,
  });
  for (const decision of decisions) {
    const thread = threadOf(decision.threadId);
    const source = decision.source;
    // Answered by the run it is already doing; see the topics panel.
    if (source.kind === "turn-review" && isRunning(thread)) continue;
    const topic =
      decision.topicId !== null
        ? (topicById.get(decision.topicId) ?? null)
        : decision.threadId !== null
          ? (topicByThreadId.get(decision.threadId) ?? null)
          : null;
    const kind: FirstMateQueueItemKind =
      source.kind === "turn-review"
        ? "turn-review"
        : source.kind === "firstmate"
          ? "supervisor-question"
          : "provider-request";
    if (kind === "provider-request" && decision.threadId !== null) {
      threadsWithProviderCard.add(decision.threadId);
    }
    const verdict = source.kind === "turn-review" ? (source.verdict ?? null) : null;
    items.push({
      key: `decision:${decision.key}`,
      kind,
      priority: firstMateQueuePriority({ kind, blocking: decision.blocking, verdict }),
      environmentId: decision.environmentId,
      projectId: decision.projectId,
      threadId: decision.threadId,
      threadTitle: thread?.title ?? null,
      topicTitle: topic?.title ?? null,
      topicSummary: topic?.summary ?? null,
      latestRoundSummary: topic?.latestRoundSummary?.text ?? null,
      headline:
        kind === "turn-review"
          ? verdict?.outcome === "blocked"
            ? "The agent is blocked"
            : "The agent stopped and needs a decision"
          : kind === "supervisor-question"
            ? "FirstMate asks"
            : "The agent is waiting on a request",
      detail: decision.question,
      decision: {
        decisionId: decision.decisionId,
        sourceKind: source.kind,
        options: decision.options,
        recommendedOptionId: decision.recommendedOptionId,
        blocking: decision.blocking,
      },
      verdict,
      pullRequests: firstMatePanelPullRequests(thread?.pullRequests ?? [], nowMs),
      // A provider request is answered through its own prompt, not a message.
      canReply: kind !== "provider-request" && thread !== null,
      updatedAt: decision.updatedAt,
    });
  }

  for (const topic of workspace.topics) {
    const thread = threadOf(topic.threadId);
    if (thread === null || thread.archivedAt !== null || isRunning(thread)) continue;
    // Keys carry the latest turn, so something set aside comes back after the
    // next run if it still needs the user.
    const turnKey = thread.latestTurn?.turnId ?? "none";
    const base = {
      environmentId: project.environmentId,
      projectId: project.id,
      threadId: thread.id,
      threadTitle: thread.title,
      topicTitle: topic.title,
      topicSummary: topic.summary,
      latestRoundSummary: topic.latestRoundSummary?.text ?? null,
      decision: null,
      verdict: null,
    };
    const pullRequests = firstMatePanelPullRequests(thread.pullRequests, nowMs);
    const lastActivity = thread.latestTurn?.completedAt ?? thread.updatedAt;

    if (
      (thread.hasPendingApprovals || thread.hasPendingUserInput) &&
      !threadsWithProviderCard.has(thread.id)
    ) {
      items.push({
        ...base,
        key: `request:${project.environmentId}:${thread.id}:${turnKey}`,
        kind: "provider-request",
        priority: firstMateQueuePriority({ kind: "provider-request" }),
        headline: thread.hasPendingApprovals
          ? "The agent is waiting for an approval"
          : "The agent asked a question",
        detail: null,
        pullRequests,
        canReply: false,
        updatedAt: lastActivity,
      });
    }

    if (thread.session?.status === "error" || thread.session?.status === "interrupted") {
      items.push({
        ...base,
        key: `failed:${project.environmentId}:${thread.id}:${turnKey}`,
        kind: "failed-run",
        priority: firstMateQueuePriority({ kind: "failed-run" }),
        headline: thread.session.status === "error" ? "The run failed" : "The run was interrupted",
        detail: thread.session.lastError,
        pullRequests,
        canReply: true,
        updatedAt: thread.session.updatedAt,
      });
    }

    for (const pullRequest of pullRequests) {
      if (!ATTENTION_PULL_REQUEST_STATUSES.has(pullRequest.status)) continue;
      items.push({
        ...base,
        key: `pr:${project.environmentId}:${thread.id}:${pullRequest.key}:${pullRequest.headSha ?? "?"}:${pullRequest.status}:${turnKey}`,
        kind: "pull-request",
        priority: firstMateQueuePriority({
          kind: "pull-request",
          pullRequestStatus: pullRequest.status,
        }),
        headline: `${PULL_REQUEST_HEADLINES[pullRequest.status] ?? "Needs attention"} on #${pullRequest.number}`,
        detail: pullRequest.title,
        pullRequests: [pullRequest],
        canReply: true,
        updatedAt: pullRequest.syncedAt ?? lastActivity,
      });
    }
  }

  return items.toSorted(compareQueueItems);
}

/**
 * The user's place in the queue. `reading` is a snapshot of the item on
 * screen: while it is set, nothing else takes its place, even when a newer or
 * more urgent item arrives or the item itself resolves elsewhere.
 */
export interface FirstMateQueueCursor {
  readonly reading: FirstMateQueueItem | null;
  /** Keys set aside with "Later", oldest first; they go to the back. */
  readonly deferred: ReadonlyArray<string>;
  /** Keys already answered here, hidden until the server catches up. */
  readonly handled: ReadonlyArray<string>;
}

export const EMPTY_FIRST_MATE_QUEUE_CURSOR: FirstMateQueueCursor = {
  reading: null,
  deferred: [],
  handled: [],
};

export interface FirstMateQueueView {
  readonly current: FirstMateQueueItem | null;
  /** The item on screen left the queue (answered elsewhere or resolved). */
  readonly currentGone: boolean;
  /** Everything behind the current item, live-ranked. */
  readonly upNext: ReadonlyArray<FirstMateQueueItem>;
}

export function presentFirstMateQueue(
  queue: ReadonlyArray<FirstMateQueueItem>,
  cursor: FirstMateQueueCursor,
): FirstMateQueueView {
  const handled = new Set(cursor.handled);
  const deferredRank = new Map(cursor.deferred.map((key, index) => [key, index] as const));
  const open = queue.filter((item) => !handled.has(item.key));
  const ordered = [
    ...open.filter((item) => !deferredRank.has(item.key)),
    ...open
      .filter((item) => deferredRank.has(item.key))
      .toSorted((left, right) => deferredRank.get(left.key)! - deferredRank.get(right.key)!),
  ];
  const reading = cursor.reading;
  if (reading === null) {
    return { current: ordered[0] ?? null, currentGone: false, upNext: ordered.slice(1) };
  }
  const live = ordered.find((item) => item.key === reading.key);
  return {
    current: live ?? reading,
    currentGone: live === undefined,
    upNext: ordered.filter((item) => item.key !== reading.key),
  };
}

/** Pin the item about to be shown, so later arrivals queue behind it. */
export function pinFirstMateQueueItem(
  cursor: FirstMateQueueCursor,
  item: FirstMateQueueItem,
): FirstMateQueueCursor {
  return cursor.reading?.key === item.key ? cursor : { ...cursor, reading: item };
}

/** The user acted on the item: drop it and move to the top of the queue. */
export function completeFirstMateQueueItem(
  cursor: FirstMateQueueCursor,
  key: string,
): FirstMateQueueCursor {
  return {
    reading: null,
    deferred: cursor.deferred.filter((entry) => entry !== key),
    handled: cursor.handled.includes(key) ? cursor.handled : [...cursor.handled, key],
  };
}

/** "Later": send the item to the back and move to the top of the queue. */
export function deferFirstMateQueueItem(
  cursor: FirstMateQueueCursor,
  key: string,
): FirstMateQueueCursor {
  return {
    ...cursor,
    reading: null,
    deferred: [...cursor.deferred.filter((entry) => entry !== key), key],
  };
}
