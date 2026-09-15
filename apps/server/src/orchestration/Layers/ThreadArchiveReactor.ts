import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ThreadArchiveReactor,
  type ThreadArchiveReactorShape,
} from "../Services/ThreadArchiveReactor.ts";

type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;
type AttemptStatus = "succeeded" | "not-running" | "failed";
type ProviderArchiveOutcome =
  | { readonly status: "archived" | "unsupported"; readonly provider: ProviderDriverKind }
  | { readonly status: "not-linked" | "failed" };

function failureTag(cause: Cause.Cause<unknown>): string | undefined {
  const failure = Cause.findErrorOption(cause);
  if (Option.isNone(failure)) return undefined;
  const value = failure.value;
  if (typeof value !== "object" || value === null || !("_tag" in value)) return undefined;
  return typeof value._tag === "string" ? value._tag : undefined;
}

function isMissingSessionCause(cause: Cause.Cause<unknown>): boolean {
  const tag = failureTag(cause);
  return tag === "ProviderSessionNotFoundError" || tag === "ProviderAdapterSessionNotFoundError";
}

function archiveSummary(input: {
  readonly provider: ProviderArchiveOutcome;
  readonly runtime: AttemptStatus;
  readonly terminals: Exclude<AttemptStatus, "not-running">;
}): string {
  const provider =
    input.provider.status === "archived"
      ? `Provider conversation archived (${input.provider.provider}).`
      : input.provider.status === "unsupported"
        ? `Provider does not support remote archiving (${input.provider.provider}).`
        : input.provider.status === "not-linked"
          ? "No provider conversation was linked."
          : "Provider conversation archive failed.";
  const runtime =
    input.runtime === "succeeded"
      ? "Runtime stopped."
      : input.runtime === "not-running"
        ? "No runtime was running."
        : "Runtime stop failed.";
  const terminals =
    input.terminals === "succeeded"
      ? "Local transcript preserved."
      : "Local transcript preserved, but terminal close failed.";
  return `${provider} ${runtime} ${terminals}`;
}

export const processThreadArchived = Effect.fn("processThreadArchived")(function* (input: {
  readonly event: ThreadArchivedEvent;
  readonly providerService: ProviderServiceShape;
  readonly terminalManager: TerminalManager.TerminalManager["Service"];
  readonly orchestrationEngine: OrchestrationEngineShape;
}) {
  const { event, providerService, terminalManager, orchestrationEngine } = input;
  const { threadId } = event.payload;

  const providerExit = yield* Effect.exit(providerService.archiveConversation(threadId));
  if (Exit.isFailure(providerExit) && Cause.hasInterruptsOnly(providerExit.cause)) {
    return yield* Effect.failCause(providerExit.cause);
  }
  const provider: ProviderArchiveOutcome = Exit.isSuccess(providerExit)
    ? providerExit.value
    : isMissingSessionCause(providerExit.cause)
      ? { status: "not-linked" }
      : { status: "failed" };

  const runtime: AttemptStatus =
    provider.status === "not-linked"
      ? "not-running"
      : yield* Effect.gen(function* () {
          const runtimeExit = yield* Effect.exit(providerService.stopSession({ threadId }));
          if (Exit.isFailure(runtimeExit) && Cause.hasInterruptsOnly(runtimeExit.cause)) {
            return yield* Effect.failCause(runtimeExit.cause);
          }
          return Exit.isSuccess(runtimeExit)
            ? "succeeded"
            : isMissingSessionCause(runtimeExit.cause)
              ? "not-running"
              : "failed";
        });

  // Omit deleteHistory so the terminal transcript remains recoverable with
  // the archived thread. Only the panes/processes are closed.
  const terminalExit = yield* Effect.exit(terminalManager.close({ threadId }));
  if (Exit.isFailure(terminalExit) && Cause.hasInterruptsOnly(terminalExit.cause)) {
    return yield* Effect.failCause(terminalExit.cause);
  }
  const terminals = Exit.isSuccess(terminalExit) ? "succeeded" : "failed";
  const hasFailure = provider.status === "failed" || runtime === "failed" || terminals === "failed";

  yield* orchestrationEngine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make(`server:archive-receipt:${event.eventId}`),
    threadId,
    createdAt: event.occurredAt,
    activity: {
      id: EventId.make(`archive-receipt:${event.eventId}`),
      tone: hasFailure ? "error" : "info",
      kind: "thread.archive.receipt",
      summary: archiveSummary({ provider, runtime, terminals }),
      payload: {
        local: { status: "archived", transcript: "preserved" },
        provider,
        runtime: { status: runtime },
        terminals: { status: terminals, history: "preserved" },
      },
      turnId: null,
      createdAt: event.occurredAt,
    },
  });
});

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const processThreadArchivedSafely = (event: ThreadArchivedEvent) =>
    processThreadArchived({ event, providerService, terminalManager, orchestrationEngine }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("thread archive reactor failed to record receipt", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(processThreadArchivedSafely);

  const start: ThreadArchiveReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.archived" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return { start } satisfies ThreadArchiveReactorShape;
});

export const ThreadArchiveReactorLive = Layer.effect(ThreadArchiveReactor, make);
