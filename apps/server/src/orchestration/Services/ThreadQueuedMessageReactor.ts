/**
 * ThreadQueuedMessageReactor - Drains the server-owned composer queue.
 *
 * A message the user queues while a turn runs is a fact of the thread, not of
 * the tab that queued it. This reactor watches the event stream and starts each
 * queued turn when the thread reaches a boundary, so the queue moves whether or
 * not anyone has the thread open — or is connected at all.
 *
 * @module ThreadQueuedMessageReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadQueuedMessageReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves once every observed event has been evaluated. For tests. */
  readonly drain: Effect.Effect<void>;
}

export class ThreadQueuedMessageReactor extends Context.Service<
  ThreadQueuedMessageReactor,
  ThreadQueuedMessageReactorShape
>()("t3/orchestration/Services/ThreadQueuedMessageReactor") {}
