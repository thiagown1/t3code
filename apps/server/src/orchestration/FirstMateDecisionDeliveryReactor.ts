/**
 * FirstMateDecisionDeliveryReactor - hands a resolved decision back to whoever asked it.
 *
 * Resolving a decision records the user's choice, but a recorded choice nobody
 * reads is not an answer. This reactor is the delivery half: it turns
 * `firstmate.decision-resolved` into a queued message on the thread that opened
 * the decision, so the asking agent picks the answer up on its own schedule
 * whether or not a client is connected.
 *
 * A decision opened from a native provider request (`user-input`/`approval`)
 * is answered on that request instead, via `thread.approval.respond` or
 * `thread.user-input.respond`. That is only safe because the card was built
 * *from* the request by `firstMateRequestDecisions`, so the chosen option maps
 * to exactly one provider reply; this module re-reads the live request and
 * rebuilds the reply from it rather than trusting the stored card.
 *
 * Delivery is fail-closed everywhere. A source with no thread, a thread that is
 * archived, deleted or in another project, a request that is no longer open or
 * is of the other kind, and an option the live request does not offer all end
 * in a refusal and a log line. Landing an answer on the wrong request would
 * authorize a command the user never saw, so nothing here approximates.
 *
 * @module FirstMateDecisionDeliveryReactor
 */
import {
  CommandId,
  MessageId,
  ThreadId,
  ThreadQueuedMessageId,
  type FirstMateDecision,
  type FirstMateDecisionOption,
  type OrchestrationEvent,
  type ProjectId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { firstMateRequestReply } from "./firstMateRequestDecisions.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { openRequests, THREAD_REQUEST_ACTIVITY_KINDS } from "./threadOpenRequests.ts";

export class FirstMateDecisionDeliveryReactor extends Context.Service<
  FirstMateDecisionDeliveryReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/FirstMateDecisionDeliveryReactor") {}

type FirstMateDomainEvent = Extract<OrchestrationEvent, { type: "firstmate.domain-event" }>;
type DecisionResolvedEvent = FirstMateDomainEvent & {
  readonly payload: Extract<
    FirstMateDomainEvent["payload"],
    { type: "firstmate.decision-resolved" }
  >;
};

/** Why a resolved decision was not delivered, for the one log line that says so. */
type UndeliverableReason =
  | "no-selected-option"
  | "decision-not-found"
  | "unknown-option"
  | "source-not-a-live-thread"
  | "source-in-another-project"
  | "request-source-without-thread"
  | "request-no-longer-open"
  | "request-kind-mismatch"
  | "option-has-no-provider-reply";

function isDecisionResolvedEvent(event: OrchestrationEvent): event is DecisionResolvedEvent {
  return (
    event.type === "firstmate.domain-event" && event.payload.type === "firstmate.decision-resolved"
  );
}

/**
 * What the asking thread reads. It reports the user's pick and nothing else:
 * the agent that opened the decision already knows what it asked and what each
 * option implied, so restating the option verbatim is the whole answer.
 */
function deliveryText(input: {
  readonly decision: FirstMateDecision;
  readonly selectedOptionId: string;
  readonly optionLabel: string;
  readonly optionDescription: string;
}): string {
  return [
    "The user answered a FirstMate decision.",
    "",
    `Question: ${input.decision.question}`,
    `Chosen option: ${input.optionLabel} (${input.selectedOptionId})`,
    `What that means: ${input.optionDescription}`,
  ].join("\n");
}

type DeliveryContext = {
  readonly engine: OrchestrationEngine.OrchestrationEngineShape;
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly projectId: ProjectId;
  readonly decision: FirstMateDecision;
  readonly option: FirstMateDecisionOption;
  readonly selectedOptionId: string;
  readonly skip: (reason: UndeliverableReason) => Effect.Effect<void>;
};

/**
 * Answer the provider request the card was built from.
 *
 * Nothing here trusts the stored card on its own. The source names one thread,
 * that thread is re-read live, the request must still be open and of the kind
 * the source claims, and the reply is rebuilt from the live request payload —
 * so an answer can only ever land on the exact request the user was shown.
 */
const deliverToProviderRequest = Effect.fn("deliverToProviderRequest")(function* (
  context: DeliveryContext & {
    readonly source: Extract<FirstMateDecision["source"], { requestId: unknown }>;
  },
) {
  const { snapshots, engine, projectId, decision, option, selectedOptionId, source, skip } =
    context;

  // Without a thread there is no request to answer: a provider request id is
  // unique only inside one provider session, so searching for a match could
  // land on a different thread's request. Decisions written before the source
  // carried a thread take this path and are refused.
  if (source.threadId === null) return yield* skip("request-source-without-thread");

  const thread = yield* snapshots.getThreadShellById(source.threadId);
  if (Option.isNone(thread)) return yield* skip("source-not-a-live-thread");
  if (thread.value.projectId !== projectId) return yield* skip("source-in-another-project");

  const detail = yield* snapshots.getThreadDetailById(source.threadId, {
    activityKinds: THREAD_REQUEST_ACTIVITY_KINDS,
  });
  if (Option.isNone(detail)) return yield* skip("source-not-a-live-thread");

  // Answered in the thread, cancelled, or gone stale while the card sat in the
  // inbox. Re-answering it would be a second reply to a settled request.
  const request = openRequests(detail.value).get(source.requestId);
  if (request === undefined) return yield* skip("request-no-longer-open");
  const expectedKind = source.kind === "approval" ? "approval.requested" : "user-input.requested";
  if (request.kind !== expectedKind) return yield* skip("request-kind-mismatch");

  const reply = firstMateRequestReply({
    activity: request,
    selectedOptionId,
    optionLabel: option.label,
  });
  if (reply === null) return yield* skip("option-has-no-provider-reply");

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const commandId = CommandId.make(`server:firstmate-request-answer:${decision.id}`);
  yield* engine.dispatch(
    reply.kind === "approval"
      ? {
          type: "thread.approval.respond",
          commandId,
          threadId: source.threadId,
          requestId: source.requestId,
          decision: reply.decision,
          createdAt,
        }
      : {
          type: "thread.user-input.respond",
          commandId,
          threadId: source.threadId,
          requestId: source.requestId,
          answers: reply.answers,
          createdAt,
        },
  );
});

/**
 * Deliver one resolved decision, or refuse and say why.
 *
 * Every id is derived from the decision id, so a redelivered event is the same
 * command and the engine's receipt dedupe collapses it instead of answering
 * twice.
 *
 * @internal Exported for tests.
 */
export const processDecisionResolved = Effect.fn("processDecisionResolved")(function* (input: {
  readonly event: DecisionResolvedEvent;
  readonly engine: OrchestrationEngine.OrchestrationEngineShape;
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
}) {
  const { event, engine, snapshots } = input;
  const { projectId, decisionId, selectedOptionId } = event.payload;
  const skip = (reason: UndeliverableReason) =>
    Effect.logWarning("FirstMate decision answer was not delivered", { decisionId, reason });

  if (selectedOptionId === null) return yield* skip("no-selected-option");

  const project = yield* snapshots.getProjectShellById(projectId);
  const decision = Option.isNone(project)
    ? undefined
    : (project.value.firstMate?.decisions.find((entry) => entry.id === decisionId) ?? undefined);
  if (decision === undefined) return yield* skip("decision-not-found");

  const option = decision.options.find((entry) => entry.id === selectedOptionId);
  if (option === undefined) return yield* skip("unknown-option");

  if (decision.source.kind !== "firstmate") {
    return yield* deliverToProviderRequest({
      engine,
      snapshots,
      projectId,
      decision,
      option,
      selectedOptionId,
      source: decision.source,
      skip,
    });
  }

  // The asker is the thread named by the source, not whichever thread is the
  // supervisor now: relinking the supervisor does not move an open question.
  // An imported or synthetic source id resolves to no thread and is refused,
  // and this lookup already excludes archived and deleted threads.
  const destinationId = ThreadId.make(decision.source.sourceId);
  const destination = yield* snapshots.getThreadShellById(destinationId);
  if (Option.isNone(destination)) return yield* skip("source-not-a-live-thread");
  if (destination.value.projectId !== projectId) return yield* skip("source-in-another-project");

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* engine.dispatch({
    type: "thread.queued-message.enqueue",
    commandId: CommandId.make(`server:firstmate-decision-answer:${decisionId}`),
    threadId: destinationId,
    queuedMessageId: ThreadQueuedMessageId.make(`firstmate-decision-answer:${decisionId}`),
    message: {
      messageId: MessageId.make(`firstmate-decision-answer:${decisionId}`),
      role: "user",
      text: deliveryText({
        decision,
        selectedOptionId,
        optionLabel: option.label,
        optionDescription: option.description,
      }),
      attachments: [],
    },
    // The answer is context, never an interrupt: a supervisor mid-turn keeps
    // its train of thought and reads the answer when the turn ends.
    dispatchTiming: "after-current-turn",
    queuedAfterActivityId: null,
    createdAt,
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const handleSafely = (event: DecisionResolvedEvent) =>
    processDecisionResolved({ event, engine, snapshots }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("FirstMate decision delivery failed", {
              decisionId: event.payload.decisionId,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(handleSafely);

  const start: FirstMateDecisionDeliveryReactor["Service"]["start"] = Effect.fn(
    "FirstMateDecisionDeliveryReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        isDecisionResolvedEvent(event) ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies FirstMateDecisionDeliveryReactor["Service"];
});

export const layer = Layer.effect(FirstMateDecisionDeliveryReactor, make);
