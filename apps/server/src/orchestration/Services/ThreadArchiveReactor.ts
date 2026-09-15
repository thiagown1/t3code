/**
 * ThreadArchiveReactor - Provider and runtime cleanup after local archiving.
 *
 * The local thread archive is the durable source event. This reactor performs
 * provider-native archiving when supported, stops the runtime, closes terminal
 * panes without deleting their history, and appends one auditable receipt.
 *
 * @module ThreadArchiveReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadArchiveReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ThreadArchiveReactor extends Context.Service<
  ThreadArchiveReactor,
  ThreadArchiveReactorShape
>()("t3/orchestration/Services/ThreadArchiveReactor") {}
