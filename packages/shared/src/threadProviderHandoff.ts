import { sha256 } from "@noble/hashes/sha2";
import {
  THREAD_PROVIDER_HANDOFF_MAX_ATTACHMENTS_PER_MESSAGE,
  THREAD_PROVIDER_HANDOFF_MAX_CONTEXT_BYTES,
  THREAD_PROVIDER_HANDOFF_MAX_DECISIONS,
  THREAD_PROVIDER_HANDOFF_MAX_MESSAGES,
  THREAD_PROVIDER_HANDOFF_MAX_OMISSION_KINDS,
  THREAD_PROVIDER_HANDOFF_MAX_PLAN_CHARS,
  THREAD_PROVIDER_HANDOFF_MAX_PLANS,
  THREAD_PROVIDER_HANDOFF_SCHEMA_VERSION,
  ThreadProviderHandoffAttachment,
  ThreadProviderHandoffContext,
  ThreadProviderHandoffDecision,
  ThreadProviderHandoffEnvelope,
  ThreadProviderHandoffMessage,
  type ThreadProviderHandoffOmissionKind,
  ThreadProviderHandoffPlan,
  ThreadProviderHandoffProvider,
  type ThreadProviderHandoffReason,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeAttachment = Schema.decodeUnknownSync(ThreadProviderHandoffAttachment);
const decodeContext = Schema.decodeUnknownSync(ThreadProviderHandoffContext);
const decodeDecision = Schema.decodeUnknownSync(ThreadProviderHandoffDecision);
const decodeEnvelope = Schema.decodeUnknownSync(ThreadProviderHandoffEnvelope);
const decodeMessage = Schema.decodeUnknownSync(ThreadProviderHandoffMessage);
const decodePlan = Schema.decodeUnknownSync(ThreadProviderHandoffPlan);
const decodeProvider = Schema.decodeUnknownSync(ThreadProviderHandoffProvider);

type UnknownRecord = Readonly<Record<string, unknown>>;

export type ThreadProviderHandoffSanitizationInput = {
  readonly schemaVersion?: 1;
  readonly handoffId: string;
  readonly threadId: string;
  readonly source: unknown;
  readonly target: unknown;
  readonly reason: ThreadProviderHandoffReason;
  readonly sequence: number;
  readonly sourceTurnId?: string;
  readonly projectId: string;
  readonly runtimeMode: ThreadProviderHandoffContext["runtimeMode"];
  readonly interactionMode: ThreadProviderHandoffContext["interactionMode"];
  readonly branch?: string | null;
  readonly messages: ReadonlyArray<unknown>;
  readonly proposedPlans?: ReadonlyArray<unknown>;
  readonly resolvedDecisions?: ReadonlyArray<unknown>;
  readonly createdAt: string;
  readonly [key: string]: unknown;
};

const FORBIDDEN_TOP_LEVEL_KEYS = new Set([
  "sessionid",
  "providersessionid",
  "resumecursor",
  "cursor",
  "credentials",
  "credential",
  "headers",
  "env",
  "environment",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "cookies",
  "worktreepath",
  "absolutepath",
  "path",
  "reasoning",
  "tool",
  "toolcall",
  "toolpayload",
  "toolresult",
  "rawtool",
  "rawtoolpayload",
  "approval",
  "approvalrequest",
  "question",
  "inputrequest",
  "streaming",
  "chainofthought",
]);

const MESSAGE_FORBIDDEN_KEYS = new Map<string, ThreadProviderHandoffOmissionKind>([
  ["tool", "tool-payload"],
  ["toolcall", "tool-payload"],
  ["toolpayload", "tool-payload"],
  ["toolresult", "tool-payload"],
  ["rawtool", "tool-payload"],
  ["approval", "approval"],
  ["approvalrequest", "approval"],
  ["question", "question"],
  ["inputrequest", "question"],
  ["reasoning", "message-context"],
  ["chainofthought", "message-context"],
  ["sessionid", "sensitive-content"],
  ["providersessionid", "sensitive-content"],
  ["resumecursor", "sensitive-content"],
  ["cursor", "sensitive-content"],
  ["credentials", "sensitive-content"],
  ["credential", "sensitive-content"],
  ["headers", "sensitive-content"],
  ["env", "sensitive-content"],
  ["environment", "sensitive-content"],
]);

const SECRET_TEXT =
  /(?:-----BEGIN [^-]+ PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{16,}|\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}|\b(?:ghp|gho|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]{8,})/i;
const ABSOLUTE_PATH =
  /(?:^|[\s("'`])(?:[a-zA-Z]:[\\/]|\\\\|\/(?:Users|home|root|tmp|var|etc|opt|private)\/)/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = asRecord(value);
  if (!record) throw new Error("Thread provider handoff contains a non-JSON value");
  const entries = Object.entries(record)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function hashJson(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(stableJson(value))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function hasAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH.test(value);
}

function hasSensitiveText(value: string): boolean {
  return SECRET_TEXT.test(value);
}

function increment(
  counts: Map<ThreadProviderHandoffOmissionKind, number>,
  kind: ThreadProviderHandoffOmissionKind,
  amount = 1,
): void {
  if (amount > 0) counts.set(kind, (counts.get(kind) ?? 0) + amount);
}

function assertNoForbiddenTopLevel(input: ThreadProviderHandoffSanitizationInput): void {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_TOP_LEVEL_KEYS.has(normalizeKey(key))) {
      throw new Error(`Thread provider handoff contains forbidden field: ${key}`);
    }
  }
}

function assertPortableValue(value: unknown): void {
  if (typeof value === "string") {
    if (hasSensitiveText(value)) {
      throw new Error("Thread provider handoff contains sensitive text");
    }
    if (hasAbsolutePath(value)) {
      throw new Error("Thread provider handoff contains an absolute path");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertPortableValue(entry);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (FORBIDDEN_TOP_LEVEL_KEYS.has(normalizeKey(key))) {
      throw new Error(`Thread provider handoff contains forbidden field: ${key}`);
    }
    if (
      record.availability === "reference-only" &&
      ["source", "content", "data", "bytes", "base64", "url", "path"].includes(normalizeKey(key))
    ) {
      throw new Error(`Thread provider handoff attachment contains forbidden field: ${key}`);
    }
    assertPortableValue(entry);
  }
}

function sanitizeProvider(
  value: unknown,
  label: "source" | "target",
): ThreadProviderHandoffProvider {
  const record = asRecord(value);
  if (!record) throw new Error(`Thread provider handoff ${label} provider is invalid`);
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TOP_LEVEL_KEYS.has(normalizeKey(key))) {
      throw new Error(`Thread provider handoff ${label} provider contains forbidden field: ${key}`);
    }
  }
  return decodeProvider({
    providerInstanceId: record.providerInstanceId,
    driver: record.driver,
    model: record.model,
  });
}

function sanitizeAttachment(
  attachment: unknown,
  counts: Map<ThreadProviderHandoffOmissionKind, number>,
): ThreadProviderHandoffAttachment | null {
  const value = asRecord(attachment);
  if (!value) {
    increment(counts, "unvalidated-attachment");
    return null;
  }
  for (const key of Object.keys(value)) {
    const normalized = normalizeKey(key);
    if (normalized === "source") increment(counts, "attachment-source");
    if (["content", "data", "bytes", "base64", "url", "path"].includes(normalized)) {
      increment(counts, "attachment-content");
    }
  }
  const stringValues = [value.id, value.type, value.name, value.mimeType];
  if (stringValues.some((entry) => typeof entry === "string" && hasAbsolutePath(entry))) {
    increment(counts, "absolute-path");
    return null;
  }
  try {
    return decodeAttachment({
      sourceAttachmentId: value.id,
      type: value.type,
      name: value.name,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes,
      availability: "reference-only",
    });
  } catch {
    increment(counts, "unvalidated-attachment");
    return null;
  }
}

function sanitizeMessage(
  message: unknown,
  counts: Map<ThreadProviderHandoffOmissionKind, number>,
): ThreadProviderHandoffMessage | null {
  const value = asRecord(message);
  if (!value) {
    increment(counts, "invalid-message");
    return null;
  }
  if (value.streaming === true) {
    increment(counts, "streaming-message");
    return null;
  }
  if (value.complete === false) {
    increment(counts, "incomplete-message");
    return null;
  }
  const forbiddenKinds = new Set<ThreadProviderHandoffOmissionKind>();
  for (const key of Object.keys(value)) {
    const kind = MESSAGE_FORBIDDEN_KEYS.get(normalizeKey(key));
    if (kind) forbiddenKinds.add(kind);
  }
  if (forbiddenKinds.size > 0) {
    for (const kind of forbiddenKinds) increment(counts, kind);
    return null;
  }
  if (value.context !== undefined) increment(counts, "message-context");
  if (typeof value.text === "string" && hasSensitiveText(value.text)) {
    increment(counts, "sensitive-content");
    return null;
  }
  if (typeof value.text === "string" && hasAbsolutePath(value.text)) {
    increment(counts, "absolute-path");
    return null;
  }
  const rawAttachments = value.attachments ?? [];
  if (!Array.isArray(rawAttachments)) {
    increment(counts, "invalid-message");
    return null;
  }
  if (rawAttachments.length > THREAD_PROVIDER_HANDOFF_MAX_ATTACHMENTS_PER_MESSAGE) {
    increment(counts, "invalid-message");
    return null;
  }
  const attachments = rawAttachments
    .map((entry) => sanitizeAttachment(entry, counts))
    .filter((entry): entry is ThreadProviderHandoffAttachment => entry !== null);
  try {
    return decodeMessage({
      sourceMessageId: value.id,
      role: value.role,
      text: value.text,
      attachments,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    });
  } catch {
    increment(counts, "invalid-message");
    return null;
  }
}

function sanitizePlan(
  plan: unknown,
  counts: Map<ThreadProviderHandoffOmissionKind, number>,
): ThreadProviderHandoffPlan | null {
  const value = asRecord(plan);
  if (!value || typeof value.planMarkdown !== "string") {
    increment(counts, "invalid-plan");
    return null;
  }
  for (const key of Object.keys(value)) {
    const kind = MESSAGE_FORBIDDEN_KEYS.get(normalizeKey(key));
    if (kind) {
      increment(counts, kind);
      return null;
    }
  }
  if (value.planMarkdown.length > THREAD_PROVIDER_HANDOFF_MAX_PLAN_CHARS) {
    increment(counts, "invalid-plan");
    return null;
  }
  if (hasSensitiveText(value.planMarkdown)) {
    increment(counts, "sensitive-content");
    return null;
  }
  if (hasAbsolutePath(value.planMarkdown)) {
    increment(counts, "absolute-path");
    return null;
  }
  try {
    return decodePlan({
      sourcePlanId: value.sourcePlanId ?? value.id,
      planMarkdown: value.planMarkdown,
      implementedAt: value.implementedAt ?? null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    });
  } catch {
    increment(counts, "invalid-plan");
    return null;
  }
}

function sanitizeDecision(
  decision: unknown,
  counts: Map<ThreadProviderHandoffOmissionKind, number>,
): ThreadProviderHandoffDecision | null {
  const value = asRecord(decision);
  if (!value) {
    increment(counts, "invalid-decision");
    return null;
  }
  if (Object.hasOwn(value, "question")) increment(counts, "question");
  if (Object.hasOwn(value, "approval") || Object.hasOwn(value, "source")) {
    increment(counts, "approval");
  }
  for (const key of Object.keys(value)) {
    const normalized = normalizeKey(key);
    if (["question", "approval", "source"].includes(normalized)) continue;
    const kind = MESSAGE_FORBIDDEN_KEYS.get(normalized);
    if (kind) {
      increment(counts, kind);
      return null;
    }
  }
  try {
    return decodeDecision({
      sourceDecisionId: value.sourceDecisionId ?? value.id,
      selectedOptionId: value.selectedOptionId,
      resolvedAt: value.resolvedAt,
    });
  } catch {
    increment(counts, "invalid-decision");
    return null;
  }
}

function normalizeOmissions(
  counts: Map<ThreadProviderHandoffOmissionKind, number>,
): ThreadProviderHandoffEnvelope["omissions"] {
  const omissions = [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => compareText(left.kind, right.kind));
  if (omissions.length > THREAD_PROVIDER_HANDOFF_MAX_OMISSION_KINDS) {
    throw new Error("Thread provider handoff omission kind limit exceeded");
  }
  return omissions;
}

function assertUnique(values: ReadonlyArray<string>, label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Thread provider handoff contains duplicate ${label}`);
  }
}

function envelopeWithoutHash(envelope: ThreadProviderHandoffEnvelope): UnknownRecord {
  const { envelopeHash: _envelopeHash, ...rest } = envelope;
  return rest;
}

function verifyHashes(envelope: ThreadProviderHandoffEnvelope): void {
  if (hashJson(envelope.context) !== envelope.contextHash) {
    throw new Error("Thread provider handoff context hash mismatch");
  }
  if (hashJson(envelopeWithoutHash(envelope)) !== envelope.envelopeHash) {
    throw new Error("Thread provider handoff envelope hash mismatch");
  }
}

export function sanitizeThreadProviderHandoff(
  input: ThreadProviderHandoffSanitizationInput,
): ThreadProviderHandoffEnvelope {
  assertNoForbiddenTopLevel(input);
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== THREAD_PROVIDER_HANDOFF_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported thread provider handoff schema version: ${String(input.schemaVersion)}`,
    );
  }
  if (input.messages.length > THREAD_PROVIDER_HANDOFF_MAX_MESSAGES) {
    throw new Error("Thread provider handoff message limit exceeded");
  }
  if ((input.proposedPlans?.length ?? 0) > THREAD_PROVIDER_HANDOFF_MAX_PLANS) {
    throw new Error("Thread provider handoff plan limit exceeded");
  }
  if ((input.resolvedDecisions?.length ?? 0) > THREAD_PROVIDER_HANDOFF_MAX_DECISIONS) {
    throw new Error("Thread provider handoff decision limit exceeded");
  }
  for (const value of [
    input.handoffId,
    input.threadId,
    input.sourceTurnId,
    input.projectId,
    input.branch,
  ]) {
    if (typeof value === "string" && hasAbsolutePath(value)) {
      throw new Error("Thread provider handoff identity contains an absolute path");
    }
  }

  const source = sanitizeProvider(input.source, "source");
  const target = sanitizeProvider(input.target, "target");
  for (const value of [
    source.providerInstanceId,
    source.driver,
    source.model,
    target.providerInstanceId,
    target.driver,
    target.model,
  ]) {
    if (hasSensitiveText(value) || hasAbsolutePath(value)) {
      throw new Error("Thread provider handoff provider metadata is not portable");
    }
  }

  const counts = new Map<ThreadProviderHandoffOmissionKind, number>();
  const messages = input.messages
    .map((message) => sanitizeMessage(message, counts))
    .filter((message): message is ThreadProviderHandoffMessage => message !== null);
  const proposedPlans = (input.proposedPlans ?? [])
    .map((plan) => sanitizePlan(plan, counts))
    .filter((plan): plan is ThreadProviderHandoffPlan => plan !== null)
    .sort((left, right) => compareText(left.sourcePlanId, right.sourcePlanId));
  const resolvedDecisions = (input.resolvedDecisions ?? [])
    .map((decision) => sanitizeDecision(decision, counts))
    .filter((decision): decision is ThreadProviderHandoffDecision => decision !== null)
    .sort((left, right) => compareText(left.sourceDecisionId, right.sourceDecisionId));
  assertUnique(
    messages.map((message) => message.sourceMessageId),
    "message ID",
  );
  assertUnique(
    proposedPlans.map((plan) => plan.sourcePlanId),
    "plan ID",
  );
  assertUnique(
    resolvedDecisions.map((decision) => decision.sourceDecisionId),
    "decision ID",
  );

  const context = decodeContext({
    projectId: input.projectId,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: input.branch ?? null,
    messages,
    proposedPlans,
    resolvedDecisions,
  });
  const contextJson = stableJson(context);
  const contextBytes = new TextEncoder().encode(contextJson).byteLength;
  if (contextBytes > THREAD_PROVIDER_HANDOFF_MAX_CONTEXT_BYTES) {
    throw new Error("Thread provider handoff context size limit exceeded");
  }

  const base = {
    schemaVersion: THREAD_PROVIDER_HANDOFF_SCHEMA_VERSION,
    handoffId: input.handoffId,
    threadId: input.threadId,
    source,
    target,
    reason: input.reason,
    sequence: input.sequence,
    ...(input.sourceTurnId === undefined ? {} : { sourceTurnId: input.sourceTurnId }),
    contextHash: hashJson(context),
    contextBytes,
    omissions: normalizeOmissions(counts),
    context,
    createdAt: input.createdAt,
  };
  return decodeEnvelope({ ...base, envelopeHash: hashJson(base) });
}

export function serializeThreadProviderHandoff(envelope: ThreadProviderHandoffEnvelope): string {
  assertPortableValue(envelope);
  const decoded = decodeEnvelope(envelope);
  verifyHashes(decoded);
  return `${stableJson(decoded)}\n`;
}

export function parseThreadProviderHandoff(serialized: string): ThreadProviderHandoffEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid thread provider handoff JSON");
  }
  const rawRecord = asRecord(raw);
  if (rawRecord?.schemaVersion !== THREAD_PROVIDER_HANDOFF_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported thread provider handoff schema version: ${String(rawRecord?.schemaVersion)}`,
    );
  }
  assertPortableValue(raw);
  const envelope = decodeEnvelope(raw);
  verifyHashes(envelope);
  return envelope;
}
