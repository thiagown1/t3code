import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { supervisePrLink } from "./PrSupervisionSweep.ts";
import { supervisionEnvironmentKey } from "./PrSupervisionEnvironment.ts";
import { siblingPullRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  CommandId,
  type OrchestrationThreadShell,
  type PullRequestSummary,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
  type ThreadPullRequestStack,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  threadPullRequestKeyOf,
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const SLOW_SYNC_INTERVAL_MS = 15 * 60 * 1_000;
const SNAPSHOT_FRESHNESS_RECEIPT_MS = 2 * 60 * 1_000;

type SnapshotFields = Omit<ThreadPullRequestSnapshot, "syncedAt">;

interface LinkEntry {
  readonly thread: OrchestrationThreadShell;
  readonly link: ThreadPullRequestLink;
}

function snapshotFieldsOf(summary: PullRequestSummary): SnapshotFields {
  return {
    state: summary.state,
    title: summary.title,
    headBranch: summary.headBranch,
    ...(summary.headSha === undefined ? {} : { headSha: summary.headSha }),
    baseBranch: summary.baseBranch,
    isDraft: summary.isDraft ?? false,
    updatedAt: summary.updatedAt,
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    ...(summary.author === undefined ? {} : { author: summary.author }),
    ...(summary.additions === undefined ? {} : { additions: summary.additions }),
    ...(summary.deletions === undefined ? {} : { deletions: summary.deletions }),
    ...(summary.changedFiles === undefined ? {} : { changedFiles: summary.changedFiles }),
    ...(summary.reviewDecision === undefined ? {} : { reviewDecision: summary.reviewDecision }),
    ...(summary.checksState === undefined ? {} : { checksState: summary.checksState }),
    ...(summary.checks === undefined ? {} : { checks: [...summary.checks] }),
    ...(summary.mergeability === undefined ? {} : { mergeability: summary.mergeability }),
  };
}

function snapshotFieldsEqual(left: SnapshotFields, right: SnapshotFields): boolean {
  return (
    left.state === right.state &&
    left.title === right.title &&
    left.headBranch === right.headBranch &&
    left.headSha === right.headSha &&
    left.baseBranch === right.baseBranch &&
    left.isDraft === right.isDraft &&
    left.updatedAt === right.updatedAt &&
    (left.closedAt ?? null) === (right.closedAt ?? null) &&
    (left.mergedAt ?? null) === (right.mergedAt ?? null) &&
    (left.author?.login ?? null) === (right.author?.login ?? null) &&
    (left.author?.avatarUrl ?? null) === (right.author?.avatarUrl ?? null) &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.changedFiles === right.changedFiles &&
    (left.reviewDecision ?? null) === (right.reviewDecision ?? null) &&
    (left.checksState ?? null) === (right.checksState ?? null) &&
    JSON.stringify(left.checks ?? []) === JSON.stringify(right.checks ?? []) &&
    left.mergeability === right.mergeability
  );
}

function stacksEqual(
  left: ThreadPullRequestStack | null,
  right: ThreadPullRequestStack | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.number === right.number &&
    left.url === right.url &&
    left.base === right.base &&
    left.layers.length === right.layers.length &&
    left.layers.every((layer, index) => {
      const other = right.layers[index]!;
      return (
        layer.number === other.number &&
        layer.headBranch === other.headBranch &&
        layer.state === other.state
      );
    })
  );
}

/**
 * Keeps every thread ↔ pull request link's host snapshot current. One sweep a minute reads
 * the shell snapshot, groups visible links by pull request so the host is asked once per PR
 * no matter how many threads share it, and writes back only what changed. Native stacks the
 * host reports are auto-linked to the thread as `source: "stack"`.
 */
export class PullRequestSyncReactor extends Context.Service<
  PullRequestSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** Force the next sweep to re-read this pull request, even when its snapshot is terminal. */
    readonly requestSync: (key: ThreadPullRequestKey) => Effect.Effect<void>;
  }
>()("t3/orchestration/PullRequestSyncReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environmentKey = yield* supervisionEnvironmentKey;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;

  let supervisionCursor = 0;
  const lastSyncedAt = new Map<string, number>();
  const requested = new Map<string, number>();
  let requestGeneration = 0;
  const retryStacks = new Set<string>();

  const isDue = (key: string, entries: ReadonlyArray<LinkEntry>, nowMs: number): boolean => {
    if (requested.has(key) || retryStacks.has(key)) return true;
    if (entries.some((entry) => entry.link.snapshot === null)) return true;
    if (entries.every((entry) => entry.link.snapshot?.state === "merged")) return false;
    // An open PR remains actionable after its agent session settles: checks can finish later and
    // the operator still needs the ready-to-merge notification. Archiving the thread stops it.
    if (entries.some((entry) => entry.link.snapshot?.state === "open")) return true;
    // Closed requests can reopen on the host, including after the thread settles.
    const last = lastSyncedAt.get(key);
    return last === undefined || nowMs - last >= SLOW_SYNC_INTERVAL_MS;
  };

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  const sweep = Effect.fn("PullRequestSyncReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);

    const groups = new Map<string, Array<LinkEntry>>();
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null) continue;
      for (const link of visibleThreadPullRequests(thread.pullRequests)) {
        const key = threadPullRequestKeyOf(link);
        const entries = groups.get(key) ?? [];
        entries.push({ thread, link });
        groups.set(key, entries);
      }
    }

    for (const key of lastSyncedAt.keys()) if (!groups.has(key)) lastSyncedAt.delete(key);
    for (const key of retryStacks) if (!groups.has(key)) retryStacks.delete(key);
    for (const key of requested.keys()) if (!groups.has(key)) requested.delete(key);

    // Layers auto-linked this sweep, so two links of one thread that share a
    // stack do not both try to add the same sibling.
    const linkedThisSweep = new Set<string>();

    const syncEntry = Effect.fn("PullRequestSyncReactor.syncEntry")(function* (
      entry: LinkEntry,
      fields: SnapshotFields,
      fetchedStack: { readonly stack: ThreadPullRequestStack | null } | null,
    ) {
      const { thread, link } = entry;
      const nextStack = fetchedStack === null ? link.stack : fetchedStack.stack;
      const lastSnapshotAt =
        link.snapshot === null ? Number.NaN : Date.parse(link.snapshot.syncedAt);
      const freshnessReceiptDue =
        !Number.isFinite(lastSnapshotAt) || nowMs - lastSnapshotAt >= SNAPSHOT_FRESHNESS_RECEIPT_MS;
      const changed =
        link.snapshot === null ||
        !snapshotFieldsEqual(link.snapshot, fields) ||
        !stacksEqual(link.stack, nextStack) ||
        freshnessReceiptDue;
      if (changed) {
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`server:pr-sync:${thread.id}:${uuid}`),
          threadId: thread.id,
          host: normalizeThreadPullRequestKey(link).host,
          repository: link.repository,
          number: link.number,
          snapshot: { ...fields, syncedAt: nowIso },
          stack: nextStack,
        });
      }
      if (fetchedStack === null || fetchedStack.stack === null) return;
      for (const layer of fetchedStack.stack.layers) {
        const layerKey = {
          host: normalizeThreadPullRequestKey(link).host,
          repository: link.repository,
          number: layer.number,
        };
        const dedupeKey = `${thread.id}:${threadPullRequestKeyOf(layerKey)}`;
        if (linkedThisSweep.has(dedupeKey)) continue;
        // Tombstones count as present: a dismissed layer is never re-added.
        if (
          thread.pullRequests.some((existing) => threadPullRequestKeysEqual(existing, layerKey))
        ) {
          continue;
        }
        const url = siblingPullRequestUrl(link.url, layer.number);
        if (url === null) continue;
        linkedThisSweep.add(dedupeKey);
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine
          .dispatch({
            type: "thread.pull-request.link",
            commandId: CommandId.make(`server:pr-stack-link:${thread.id}:${uuid}`),
            threadId: thread.id,
            ...layerKey,
            url,
            source: "stack",
          })
          .pipe(
            Effect.catchCause(
              logSkipped("pull request stack layer link skipped", {
                threadId: thread.id,
                number: layer.number,
              }),
            ),
          );
      }
    });

    const syncGroup = Effect.fn("PullRequestSyncReactor.syncGroup")(function* (
      key: string,
      entries: ReadonlyArray<LinkEntry>,
    ) {
      const first = entries[0]!;
      const ref = {
        projectId: first.thread.projectId,
        host: normalizeThreadPullRequestKey(first.link).host,
        repository: first.link.repository,
        number: first.link.number,
      };
      const generation = requested.get(key);
      if (generation !== undefined) yield* pullRequests.invalidate({ reference: ref });
      const summary = yield* pullRequests.summary(ref, { recoverTransientFailure: false });
      const fields = snapshotFieldsOf(summary);
      const needsStack =
        generation !== undefined ||
        retryStacks.has(key) ||
        entries.some(
          (entry) =>
            entry.link.snapshot === null || !snapshotFieldsEqual(entry.link.snapshot, fields),
        );
      const fetchedStack = needsStack
        ? yield* pullRequests.stack(ref, { includeDetails: false }).pipe(
            Effect.map((stack) => ({
              stack: stack === null ? null : ({ kind: "native", ...stack } as const),
            })),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("pull request stack lookup failed", {
                    key,
                  }).pipe(Effect.as(null)),
            ),
          )
        : null;
      if (needsStack) {
        if (fetchedStack === null) retryStacks.add(key);
        else retryStacks.delete(key);
      }
      // The host answered, so the cadence clock ticks even if a dispatch below is rejected.
      lastSyncedAt.set(key, nowMs);
      // A refresh requested while the host read was in flight belongs to the next sweep.
      if (requested.get(key) === generation) requested.delete(key);
      yield* Effect.forEach(
        entries,
        (entry) =>
          syncEntry(entry, fields, fetchedStack).pipe(
            Effect.catchCause(
              logSkipped("pull request sync skipped", { threadId: entry.thread.id, key }),
            ),
          ),
        { discard: true },
      );
    });

    yield* Effect.forEach(
      groups,
      ([key, entries]) =>
        isDue(key, entries, nowMs)
          ? syncGroup(key, entries).pipe(
              Effect.catchCause(logSkipped("pull request sync skipped", { key })),
            )
          : Effect.void,
      { concurrency: 8, discard: true },
    );
  });

  // Adapter calls have independent timeouts and must not occupy the host-sync
  // worker or postpone explicit requestSync refreshes.
  const supervisionSweep = Effect.fn("PullRequestSyncReactor.supervisionSweep")(function* () {
    const [active, archived] = yield* Effect.all([
      snapshots.getShellSnapshot(),
      snapshots.getArchivedShellSnapshot(),
    ]);
    const snapshot = {
      projects: active.projects,
      threads: [...active.threads, ...archived.threads],
    };
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    // Bound repository adapters separately from the existing cheap host sync.
    const supervised = snapshot.threads.flatMap((thread) =>
      thread.pullRequests
        .filter(
          (link) =>
            link.supervision?.environmentKey === environmentKey &&
            link.supervision.state !== "stopped",
        )
        .map((link) => ({ thread, link })),
    );
    const batch = Array.from(
      { length: Math.min(2, supervised.length) },
      (_, index) => supervised[(supervisionCursor + index) % supervised.length]!,
    );
    supervisionCursor = supervised.length
      ? (supervisionCursor + batch.length) % supervised.length
      : 0;
    for (const { thread, link } of batch) {
      const project = snapshot.projects.find((project) => project.id === thread.projectId);
      if (!project) continue;
      yield* supervisePrLink(engine, thread, project, link, nowIso, environmentKey).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catchCause(
          logSkipped("PR supervision sweep deferred", { threadId: thread.id, number: link.number }),
        ),
      );
    }
  });

  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(Effect.catchCause(logSkipped("pull request sync sweep failed", {}))),
  );

  const supervisionWorker = yield* makeDrainableWorker(() =>
    supervisionSweep().pipe(Effect.catchCause(logSkipped("PR supervision sweep failed", {}))),
  );

  const start: PullRequestSyncReactor["Service"]["start"] = Effect.fn(
    "PullRequestSyncReactor.start",
  )(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        yield* supervisionWorker.enqueue(undefined);
        yield* supervisionWorker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  const requestSync: PullRequestSyncReactor["Service"]["requestSync"] = (key) =>
    Effect.suspend(() => {
      requested.set(threadPullRequestKeyOf(key), ++requestGeneration);
      return worker.enqueue(undefined);
    });

  return { start, drain: worker.drain, requestSync } satisfies PullRequestSyncReactor["Service"];
});

export const layer = Layer.effect(PullRequestSyncReactor, make);
