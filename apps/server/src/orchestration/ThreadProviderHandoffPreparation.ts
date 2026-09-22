import * as NodeUtil from "node:util";

import type {
  FirstMateDecision,
  OrchestrationProjectShell,
  OrchestrationThread,
  ThreadId,
  ThreadProviderHandoffEnvelope,
  ThreadProviderHandoffProvider,
  ThreadProviderHandoffReason,
  TurnId,
} from "@t3tools/contracts";
import { sanitizeThreadProviderHandoff } from "@t3tools/shared/threadProviderHandoff";
import type { ProjectionPendingTurnStart } from "../persistence/Services/ProjectionTurns.ts";

export type ThreadProviderHandoffPreparationErrorCode =
  | "thread-mismatch"
  | "project-mismatch"
  | "decision-mismatch"
  | "source-mismatch"
  | "target-invalid"
  | "stale-sequence"
  | "stale-turn"
  | "stale-context"
  | "streaming"
  | "pending-approval"
  | "pending-question"
  | "session-active"
  | "session-unknown"
  | "compaction-active"
  | "queued-after-current-turn"
  | "invalid-context";

const ERROR_MESSAGES: Record<ThreadProviderHandoffPreparationErrorCode, string> = {
  "thread-mismatch": "The persisted thread does not match the handoff request.",
  "project-mismatch": "The persisted project does not match the source thread.",
  "decision-mismatch": "The persisted decisions do not match the source thread.",
  "source-mismatch": "The persisted provider selection does not match the handoff source.",
  "target-invalid": "The requested handoff target is invalid.",
  "stale-sequence":
    "The conversation changed. Review the latest messages and try the handoff again.",
  "stale-turn": "The conversation started another turn. Wait for it to finish, then try again.",
  "stale-context": "The conversation context changed. Review it and try the handoff again.",
  streaming: "Wait for the current response to finish, then try the handoff again.",
  "pending-approval": "Respond to the pending approval before changing providers.",
  "pending-question": "Answer the pending question before changing providers.",
  "session-active": "Wait for the current turn to finish before changing providers.",
  "session-unknown":
    "The current provider session could not be verified. Reconnect it and try again.",
  "compaction-active": "Wait for context compaction to finish before changing providers.",
  "queued-after-current-turn": "Send or cancel the queued message before changing providers.",
  "invalid-context":
    "The conversation could not be transferred safely. Review its content and try again.",
};

/** A deliberately small, safe error surface: no provider failures or persisted content escape. */
export class ThreadProviderHandoffPreparationError extends Error {
  readonly _tag = "ThreadProviderHandoffPreparationError";
  readonly code: ThreadProviderHandoffPreparationErrorCode;

  constructor(code: ThreadProviderHandoffPreparationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ThreadProviderHandoffPreparationError";
    this.code = code;
  }

  toJSON(): { readonly _tag: string; readonly code: ThreadProviderHandoffPreparationErrorCode } {
    return { _tag: this._tag, code: this.code };
  }
}

export interface ThreadProviderHandoffPreparationInput {
  readonly handoffId: string;
  readonly threadId: ThreadId;
  readonly source: ThreadProviderHandoffProvider;
  readonly target: ThreadProviderHandoffProvider;
  readonly reason: ThreadProviderHandoffReason;
  readonly expectedSequence: number;
  readonly expectedTurnId?: TurnId;
  readonly expectedContextHash?: string;
  readonly createdAt: string;
}

/** Values read from persistence before any handoff lifecycle or provider action begins. */
export interface ThreadProviderHandoffPreparationSnapshot {
  readonly snapshotSequence: number;
  readonly thread: OrchestrationThread;
  readonly project: OrchestrationProjectShell;
  readonly decisions: ReadonlyArray<FirstMateDecision>;
  /** Read from the pending-turn projection in the same snapshot transaction. */
  readonly pendingTurnStart: ProjectionPendingTurnStart | null;
  /** Exact provider/model targets already verified as available by the caller. */
  readonly availableTargets: ReadonlyArray<ThreadProviderHandoffProvider>;
  /**
   * Binds the caller's availability preflight to this persisted snapshot.
   * Runtime health can change afterward, so the lifecycle executor must still
   * revalidate the target before starting or committing the handoff.
   */
  readonly availableTargetsAttestation: {
    readonly version: 1;
    readonly snapshotSequence: number;
  };
}

function fail(code: ThreadProviderHandoffPreparationErrorCode): never {
  throw new ThreadProviderHandoffPreparationError(code);
}

function providerIsWellFormed(provider: ThreadProviderHandoffProvider): boolean {
  return [provider.providerInstanceId, provider.driver, provider.model].every(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function providersEqual(
  left: ThreadProviderHandoffProvider,
  right: ThreadProviderHandoffProvider,
): boolean {
  return (
    left.providerInstanceId === right.providerInstanceId &&
    left.driver === right.driver &&
    left.model === right.model
  );
}

function payloadRequestId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const requestId = (payload as Readonly<Record<string, unknown>>).requestId;
  return typeof requestId === "string" && requestId.trim().length > 0 ? requestId : null;
}

function hasOpenActivityRequest(
  thread: OrchestrationThread,
  requestedKind: "approval.requested" | "user-input.requested",
  resolvedKind: "approval.resolved" | "user-input.resolved",
): boolean {
  const open = new Set<string>();
  const activities = [...thread.activities].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      String(left.id).localeCompare(String(right.id)),
  );
  for (const activity of activities) {
    const requestId = payloadRequestId(activity.payload);
    if (activity.kind === requestedKind && requestId === null) return true;
    if (requestId === null) continue;
    if (activity.kind === requestedKind) open.add(requestId);
    if (activity.kind === resolvedKind) open.delete(requestId);
  }
  return open.size > 0;
}

function decisionsForThread(
  snapshot: ThreadProviderHandoffPreparationSnapshot,
): ReadonlyArray<FirstMateDecision> {
  const firstMate = snapshot.project.firstMate;
  if (!firstMate) {
    if (snapshot.decisions.length > 0) fail("decision-mismatch");
    return [];
  }
  if (firstMate.projectId !== snapshot.project.id) fail("decision-mismatch");

  const topicIds = new Set(
    firstMate.topics
      .filter(
        (topic) => topic.projectId === snapshot.project.id && topic.threadId === snapshot.thread.id,
      )
      .map((topic) => topic.id),
  );
  const authoritative = firstMate.decisions.filter((decision) => topicIds.has(decision.topicId));
  for (const decision of authoritative) {
    if (decision.projectId !== snapshot.project.id || !topicIds.has(decision.topicId)) {
      fail("decision-mismatch");
    }
  }
  const byId = (left: FirstMateDecision, right: FirstMateDecision) =>
    String(left.id).localeCompare(String(right.id));
  if (
    !NodeUtil.isDeepStrictEqual([...snapshot.decisions].sort(byId), [...authoritative].sort(byId))
  ) {
    fail("decision-mismatch");
  }
  return authoritative;
}

function latestUserMessage(thread: OrchestrationThread) {
  let latest: OrchestrationThread["messages"][number] | null = null;
  for (const message of thread.messages) {
    if (message.role !== "user" || String(message.id).startsWith("import:")) continue;
    if (
      latest === null ||
      Date.parse(message.createdAt) > Date.parse(latest.createdAt) ||
      (message.createdAt === latest.createdAt && String(message.id) > String(latest.id))
    ) {
      latest = message;
    }
  }
  return latest;
}

function validateSessionAndSource(
  thread: OrchestrationThread,
  source: ThreadProviderHandoffProvider,
): void {
  if (
    thread.modelSelection.instanceId !== source.providerInstanceId ||
    thread.modelSelection.model !== source.model
  ) {
    fail("source-mismatch");
  }

  const session = thread.session;
  if (
    session === null ||
    !["idle", "starting", "running", "ready", "interrupted", "stopped", "error"].includes(
      session.status,
    ) ||
    session.providerName === null ||
    session.providerInstanceId === undefined
  ) {
    fail("session-unknown");
  }
  if (
    session.status === "starting" ||
    session.status === "running" ||
    session.activeTurnId !== null ||
    thread.latestTurn?.state === "running"
  ) {
    fail("session-active");
  }
  if (
    session.threadId !== thread.id ||
    session.providerInstanceId !== source.providerInstanceId ||
    session.providerName !== source.driver
  ) {
    fail("source-mismatch");
  }
}

function validateNoPendingWork(
  thread: OrchestrationThread,
  decisions: ReadonlyArray<FirstMateDecision>,
): void {
  if (thread.messages.some((message) => message.streaming)) fail("streaming");
  if (hasOpenActivityRequest(thread, "approval.requested", "approval.resolved")) {
    fail("pending-approval");
  }
  if (
    hasOpenActivityRequest(thread, "user-input.requested", "user-input.resolved") ||
    decisions.some((decision) => decision.status === "pending")
  ) {
    fail("pending-question");
  }

  const latest = latestUserMessage(thread);
  const queued =
    latest !== null &&
    (latest.turnId === null ||
      thread.latestTurn === null ||
      [
        thread.latestTurn.requestedAt,
        thread.latestTurn.startedAt,
        thread.latestTurn.completedAt,
      ].every((value) => value === null || value < latest.createdAt));
  if (!queued) return;
  if (latest?.text.trim().toLowerCase() === "/compact") fail("compaction-active");
  fail("queued-after-current-turn");
}

/**
 * Build a portable envelope only. This function never compacts, starts a provider/session,
 * dispatches orchestration commands, or mutates the supplied persisted snapshots.
 */
export function prepareThreadProviderHandoff(
  input: ThreadProviderHandoffPreparationInput,
  snapshot: ThreadProviderHandoffPreparationSnapshot,
): ThreadProviderHandoffEnvelope {
  if (snapshot.snapshotSequence !== input.expectedSequence) fail("stale-sequence");
  if (snapshot.thread.id !== input.threadId) fail("thread-mismatch");
  if (snapshot.thread.projectId !== snapshot.project.id) fail("project-mismatch");
  if (
    input.expectedTurnId !== undefined &&
    snapshot.thread.latestTurn?.turnId !== input.expectedTurnId
  ) {
    fail("stale-turn");
  }
  if (!providerIsWellFormed(input.source)) fail("source-mismatch");
  if (
    snapshot.availableTargetsAttestation.version !== 1 ||
    snapshot.availableTargetsAttestation.snapshotSequence !== snapshot.snapshotSequence ||
    !providerIsWellFormed(input.target) ||
    providersEqual(input.source, input.target) ||
    !snapshot.availableTargets.some((target) => providersEqual(target, input.target))
  ) {
    fail("target-invalid");
  }

  if (snapshot.pendingTurnStart !== null) {
    if (snapshot.pendingTurnStart.threadId !== snapshot.thread.id) fail("thread-mismatch");
    const pendingMessage = snapshot.thread.messages.find(
      (message) => message.id === snapshot.pendingTurnStart?.messageId,
    );
    if (pendingMessage?.text.trim().toLowerCase() === "/compact") fail("compaction-active");
    fail("queued-after-current-turn");
  }
  const decisions = decisionsForThread(snapshot);
  validateNoPendingWork(snapshot.thread, decisions);
  validateSessionAndSource(snapshot.thread, input.source);

  let envelope: ThreadProviderHandoffEnvelope;
  try {
    envelope = sanitizeThreadProviderHandoff({
      handoffId: input.handoffId,
      threadId: input.threadId,
      source: input.source,
      target: input.target,
      reason: input.reason,
      sequence: snapshot.snapshotSequence,
      ...(snapshot.thread.latestTurn === null
        ? {}
        : { sourceTurnId: snapshot.thread.latestTurn.turnId }),
      projectId: snapshot.project.id,
      runtimeMode: snapshot.thread.runtimeMode,
      interactionMode: snapshot.thread.interactionMode,
      branch: snapshot.thread.branch,
      messages: snapshot.thread.messages,
      proposedPlans: snapshot.thread.proposedPlans,
      resolvedDecisions: decisions.filter((decision) => decision.status === "resolved"),
      createdAt: input.createdAt,
    });
  } catch {
    fail("invalid-context");
  }

  if (
    input.expectedContextHash !== undefined &&
    envelope.contextHash !== input.expectedContextHash
  ) {
    fail("stale-context");
  }
  return envelope;
}
