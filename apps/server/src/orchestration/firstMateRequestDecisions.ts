/**
 * firstMateRequestDecisions - project a provider request into a decision card,
 * and read a chosen card option back as the provider's own reply.
 *
 * An earlier attempt at this went the other way: take an arbitrary FirstMate
 * decision and try to land it on a provider request. That cannot be made safe.
 * A decision's option ids are free text, `thread.approval.respond` takes one of
 * five `ProviderApprovalDecision` literals, and `thread.user-input.respond`
 * takes a record keyed by question id — so the last step is always a guess, and
 * a wrong guess authorizes a command the user never authorized.
 *
 * Inverting it removes the guess. The card is built *from* the live request, so
 * every option it shows already corresponds to exactly one provider reply:
 *
 * - approval - one card option per `ProviderApprovalOption`, with the option id
 *   set to that option's `decision` literal. Reading it back is an identity.
 * - user-input - one card option per answer of a single-answer question, with
 *   the option id carrying that answer's position. Reading it back re-indexes
 *   into the same request payload and rebuilds `{ [questionId]: value }`.
 *
 * Both directions decode the live activity payload, so a request whose shape
 * this module cannot represent exactly produces no card at all rather than an
 * approximate one. Callers treat `null` as "refuse", never as "try harder".
 *
 * @module firstMateRequestDecisions
 */
import {
  ApprovalRequestId,
  FirstMateDecisionId,
  ProviderApprovalOption,
  ProviderApprovalDecision,
  UserInputRequestedPayload,
  type FirstMateDecisionOption,
  type FirstMateDecisionSource,
  type OrchestrationThreadActivity,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A decision card the user can actually choose between needs two ways out. */
const MIN_DECISION_OPTIONS = 2;

/** Cards live in the sidebar and cross the wire on every shell update. */
const MAX_QUESTION_CHARS = 240;

const decodeApprovalOptions = Schema.decodeUnknownOption(Schema.Array(ProviderApprovalOption));
const decodeUserInputRequest = Schema.decodeUnknownOption(UserInputRequestedPayload);
const isApprovalDecision = Schema.is(ProviderApprovalDecision);

/**
 * What each provider approval literal commits the user to. The provider sends
 * a label, which names the choice, but rarely says how far it reaches — and the
 * difference between "once" and "always" is the whole point of the question.
 */
const APPROVAL_OPTION_DESCRIPTION: Record<ProviderApprovalDecision, string> = {
  accept: "Allow this once.",
  acceptForSession: "Allow this, and the same thing again for the rest of this session.",
  acceptAlways: "Allow this every time from now on, without asking again.",
  decline: "Refuse this request and let the agent continue without it.",
  cancel: "Stop the request without answering it.",
};

/** Option ids for user-input answers carry the position they were read from. */
const USER_INPUT_OPTION_ID_PREFIX = "answer:";

function truncate(value: string, max: number): string {
  const trimmed = value.trim().replaceAll(/\s+/gu, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

/**
 * The same decision id for the same request, so a reconcile pass that runs
 * twice opens one card and the decider rejects the repeat as a duplicate.
 */
export function firstMateRequestDecisionId(
  threadId: ThreadId,
  requestId: ApprovalRequestId,
): FirstMateDecisionId {
  return FirstMateDecisionId.make(`fm-request:${threadId}:${requestId}`);
}

export interface FirstMateRequestDecisionDraft {
  readonly source: FirstMateDecisionSource;
  readonly question: string;
  readonly options: ReadonlyArray<FirstMateDecisionOption>;
}

function draftApprovalDecision(input: {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly activity: OrchestrationThreadActivity;
  readonly payload: Record<string, unknown>;
}): FirstMateRequestDecisionDraft | null {
  const decoded = decodeApprovalOptions(input.payload.options);
  // A provider that sends no options is asking a question this module cannot
  // state. Inventing accept/decline here would put words in its mouth.
  if (Option.isNone(decoded)) return null;

  const options: FirstMateDecisionOption[] = [];
  const seen = new Set<string>();
  for (const option of decoded.value) {
    if (seen.has(option.decision)) continue;
    seen.add(option.decision);
    options.push({
      id: option.decision,
      label: option.label,
      description:
        option.warning === undefined
          ? APPROVAL_OPTION_DESCRIPTION[option.decision]
          : `${APPROVAL_OPTION_DESCRIPTION[option.decision]} ${option.warning}`,
    });
  }
  if (options.length < MIN_DECISION_OPTIONS) return null;

  const detail = typeof input.payload.detail === "string" ? input.payload.detail : null;
  const appName = typeof input.payload.appName === "string" ? input.payload.appName : null;
  const subject = detail ?? appName;
  const question = truncate(
    subject === null ? input.activity.summary : `${input.activity.summary}: ${subject}`,
    MAX_QUESTION_CHARS,
  );
  if (question.length === 0) return null;

  return {
    source: { kind: "approval", requestId: input.requestId, threadId: input.threadId },
    question,
    options,
  };
}

function draftUserInputDecision(input: {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly payload: Record<string, unknown>;
}): FirstMateRequestDecisionDraft | null {
  const decoded = decodeUserInputRequest(input.payload);
  if (Option.isNone(decoded)) return null;
  // A card is one question with one answer. Multi-question forms and
  // multi-select answers are answered in the thread, where the composer can
  // actually collect them.
  if (decoded.value.questions.length !== 1) return null;
  const question = decoded.value.questions[0];
  if (question === undefined || question.multiSelect === true) return null;

  const options = question.options.map((option, index): FirstMateDecisionOption => ({
    id: `${USER_INPUT_OPTION_ID_PREFIX}${index}`,
    label: option.label,
    // The card needs a description and the provider's may be empty or a
    // restatement of the label; either way the label is the honest fallback.
    description: option.description.trim().length > 0 ? option.description : option.label,
  }));
  if (options.length < MIN_DECISION_OPTIONS) return null;

  const text = truncate(question.question, MAX_QUESTION_CHARS);
  if (text.length === 0) return null;

  return {
    source: { kind: "user-input", requestId: input.requestId, threadId: input.threadId },
    question: text,
    options,
  };
}

/**
 * Build the card for one open request, or refuse it.
 *
 * `null` means this request has no exact card: it is left pending on its own
 * thread, where the user answers it natively.
 */
export function draftFirstMateRequestDecision(input: {
  readonly threadId: ThreadId;
  readonly activity: OrchestrationThreadActivity;
}): FirstMateRequestDecisionDraft | null {
  const payload = activityPayload(input.activity);
  if (payload === null) return null;
  const rawRequestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  if (rawRequestId.length === 0) return null;
  const requestId = ApprovalRequestId.make(rawRequestId);

  if (input.activity.kind === "approval.requested") {
    return draftApprovalDecision({ ...input, requestId, payload });
  }
  if (input.activity.kind === "user-input.requested") {
    return draftUserInputDecision({ threadId: input.threadId, requestId, payload });
  }
  return null;
}

export type FirstMateRequestReply =
  | { readonly kind: "approval"; readonly decision: ProviderApprovalDecision }
  | { readonly kind: "user-input"; readonly answers: ProviderUserInputAnswers };

/**
 * Read a chosen card option back as the reply the provider is waiting for.
 *
 * The `activity` must be the request the decision was built from, re-read live.
 * `optionLabel` is the label the card showed; it is checked against the live
 * request so a card built from a different payload than the one being answered
 * is refused instead of silently re-indexed onto a neighbouring answer.
 */
export function firstMateRequestReply(input: {
  readonly activity: OrchestrationThreadActivity;
  readonly selectedOptionId: string;
  readonly optionLabel: string;
}): FirstMateRequestReply | null {
  const payload = activityPayload(input.activity);
  if (payload === null) return null;

  if (input.activity.kind === "approval.requested") {
    if (!isApprovalDecision(input.selectedOptionId)) return null;
    const decoded = decodeApprovalOptions(payload.options);
    if (Option.isNone(decoded)) return null;
    const option = decoded.value.find((entry) => entry.decision === input.selectedOptionId);
    if (option === undefined || option.label !== input.optionLabel) return null;
    return { kind: "approval", decision: input.selectedOptionId };
  }

  if (input.activity.kind === "user-input.requested") {
    if (!input.selectedOptionId.startsWith(USER_INPUT_OPTION_ID_PREFIX)) return null;
    const position = input.selectedOptionId.slice(USER_INPUT_OPTION_ID_PREFIX.length);
    // Digits only. `Number("")` is 0, so a lenient parse would read a
    // malformed id as "the first answer" and send one the user never picked.
    if (!/^\d+$/u.test(position)) return null;
    const index = Number(position);
    const decoded = decodeUserInputRequest(payload);
    if (Option.isNone(decoded)) return null;
    if (decoded.value.questions.length !== 1) return null;
    const question = decoded.value.questions[0];
    if (question === undefined || question.multiSelect === true) return null;
    const option = question.options[index];
    if (option === undefined || option.label !== input.optionLabel) return null;
    // `value ?? label` is the answer every client sends for this option; the
    // provider adapters match on it, so the card must not invent its own.
    return { kind: "user-input", answers: { [question.id]: option.value ?? option.label } };
  }

  return null;
}
