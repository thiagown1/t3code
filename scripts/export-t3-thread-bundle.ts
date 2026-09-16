import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - exclusive fd-based output is the safety boundary
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - synchronous CLI path comparison has no Effect runtime
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  buildThreadBundle,
  parseThreadBundleJson,
  serializeThreadBundle,
} from "@t3tools/shared/threadBundle";
import * as DateTime from "effect/DateTime";

const MAX_THREAD_BUNDLE_BYTES = 5 * 1024 * 1024;

const REQUIRED_COLUMNS = {
  projection_projects: ["project_id", "title"],
  projection_threads: [
    "thread_id",
    "project_id",
    "title",
    "branch",
    "worktree_path",
    "model_selection_json",
    "runtime_mode",
    "interaction_mode",
    "created_at",
    "updated_at",
    "archived_at",
    "deleted_at",
  ],
  projection_thread_messages: [
    "message_id",
    "thread_id",
    "role",
    "text",
    "is_streaming",
    "created_at",
    "updated_at",
    "attachments_json",
    "context_json",
  ],
  projection_thread_proposed_plans: [
    "plan_id",
    "thread_id",
    "plan_markdown",
    "created_at",
    "updated_at",
    "implemented_at",
  ],
  projection_thread_activities: ["thread_id"],
  projection_thread_sessions: ["thread_id"],
  projection_turns: ["thread_id", "checkpoint_turn_count"],
} as const;

type ExportSelection =
  | { readonly mode: "open" }
  | { readonly mode: "threads"; readonly threadIds: ReadonlyArray<string> };

export interface ExportT3ThreadBundleOptions {
  readonly databasePath: string;
  readonly environmentId: string;
  readonly outputPath: string;
  readonly selection: ExportSelection;
  readonly bundleId?: string;
  readonly exportedAt?: string;
}

export interface ExportT3ThreadBundleResult {
  readonly threadCount: number;
  readonly messageCount: number;
}

type SafeErrorCode =
  | "invalid-arguments"
  | "invalid-source"
  | "invalid-selection"
  | "unsupported-decisions"
  | "output-too-large"
  | "output-exists"
  | "output-failed";

export class OfflineThreadBundleExportError extends Error {
  readonly code: SafeErrorCode;

  constructor(code: SafeErrorCode, message: string) {
    super(message);
    this.name = "OfflineThreadBundleExportError";
    this.code = code;
  }
}

interface ThreadRow {
  readonly threadId: unknown;
  readonly projectId: unknown;
  readonly title: unknown;
  readonly projectTitle: unknown;
  readonly branch: unknown;
  readonly modelSelectionJson: unknown;
  readonly runtimeMode: unknown;
  readonly interactionMode: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly hasWorktreePath: unknown;
  readonly activityCount: unknown;
  readonly checkpointCount: unknown;
  readonly sessionCount: unknown;
}

interface MessageRow {
  readonly messageId: unknown;
  readonly threadId: unknown;
  readonly role: unknown;
  readonly text: unknown;
  readonly isStreaming: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly hasContext: unknown;
}

interface AttachmentRow {
  readonly messageId: unknown;
  readonly attachmentId: unknown;
  readonly type: unknown;
  readonly name: unknown;
  readonly mimeType: unknown;
  readonly sizeBytes: unknown;
  readonly hasSource: unknown;
}

interface PlanRow {
  readonly planId: unknown;
  readonly threadId: unknown;
  readonly planMarkdown: unknown;
  readonly implementedAt: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const fail = (code: SafeErrorCode, message: string): never => {
  throw new OfflineThreadBundleExportError(code, message);
};

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return fail("invalid-source", `Source database contains invalid ${label}`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("invalid-source", `Source database contains invalid ${label}`);
  }
  return value;
}

function sqliteBoolean(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) {
    return fail("invalid-source", `Source database contains invalid ${label}`);
  }
  return value === 1;
}

function parseModelSelection(value: unknown): {
  readonly instanceId: string;
  readonly model: string;
} {
  const json = requiredString(value, "model selection");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("invalid-source", "Source database contains invalid model selection JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("invalid-source", "Source database contains invalid model selection");
  }
  const record = parsed as Record<string, unknown>;
  const instanceId = record.instanceId ?? record.provider;
  return {
    instanceId: requiredString(instanceId, "model selection instance"),
    model: requiredString(record.model, "model selection model"),
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => requiredString(row.name, "schema column")),
  );
}

function assertSupportedSchema(database: DatabaseSync): void {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const available = tableColumns(database, table);
    if (available.size === 0 || columns.some((column) => !available.has(column))) {
      fail("invalid-source", "Source database schema is not supported");
    }
  }
}

function assertNoUnmappedDecisions(database: DatabaseSync, selectedThreadIdsJson: string): void {
  const projectColumns = tableColumns(database, "projection_projects");
  if (projectColumns.has("firstmate_json")) {
    const invalid = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM projection_projects AS projects
         WHERE projects.project_id IN (
           SELECT threads.project_id
           FROM projection_threads AS threads
           WHERE threads.thread_id IN (SELECT value FROM json_each(?))
         )
           AND projects.firstmate_json IS NOT NULL
           AND (
             json_valid(projects.firstmate_json) = 0
             OR (
               json_type(projects.firstmate_json, '$.decisions') IS NOT NULL
               AND json_type(projects.firstmate_json, '$.decisions') <> 'array'
             )
           )`,
      )
      .get(selectedThreadIdsJson);
    if (nonNegativeInteger(invalid?.count, "FirstMate decision metadata count") > 0) {
      fail("unsupported-decisions", "Source contains unsupported FirstMate decision metadata");
    }
    const decisions = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM projection_projects AS projects
         WHERE projects.project_id IN (
           SELECT threads.project_id
           FROM projection_threads AS threads
           WHERE threads.thread_id IN (SELECT value FROM json_each(?))
         )
           AND json_valid(projects.firstmate_json) = 1
           AND json_type(projects.firstmate_json, '$.decisions') = 'array'
           AND json_array_length(projects.firstmate_json, '$.decisions') > 0`,
      )
      .get(selectedThreadIdsJson);
    if (nonNegativeInteger(decisions?.count, "FirstMate decision count") > 0) {
      fail("unsupported-decisions", "Source contains FirstMate decisions that cannot be mapped");
    }
  }

  const decisionTables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND lower(name) LIKE '%decision%'",
    )
    .all();
  for (const row of decisionTables) {
    const table = requiredString(row.name, "decision table name");
    const count = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get();
    if (nonNegativeInteger(count?.count, "decision table count") > 0) {
      fail("unsupported-decisions", "Source contains decisions that cannot be mapped");
    }
  }
}

function selectThreads(database: DatabaseSync, selection: ExportSelection): Array<ThreadRow> {
  const base = `SELECT
      threads.thread_id AS threadId,
      threads.project_id AS projectId,
      threads.title,
      projects.title AS projectTitle,
      threads.branch,
      threads.model_selection_json AS modelSelectionJson,
      threads.runtime_mode AS runtimeMode,
      threads.interaction_mode AS interactionMode,
      threads.created_at AS createdAt,
      threads.updated_at AS updatedAt,
      CASE WHEN threads.worktree_path IS NULL THEN 0 ELSE 1 END AS hasWorktreePath,
      (SELECT COUNT(*) FROM projection_thread_activities AS activities
       WHERE activities.thread_id = threads.thread_id) AS activityCount,
      (SELECT COUNT(*) FROM projection_turns AS turns
       WHERE turns.thread_id = threads.thread_id
         AND turns.checkpoint_turn_count IS NOT NULL) AS checkpointCount,
      (SELECT COUNT(*) FROM projection_thread_sessions AS sessions
       WHERE sessions.thread_id = threads.thread_id) AS sessionCount
    FROM projection_threads AS threads
    INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id`;
  if (selection.mode === "open") {
    return database
      .prepare(
        `${base}
         WHERE threads.archived_at IS NULL AND threads.deleted_at IS NULL
         ORDER BY threads.project_id ASC, threads.created_at ASC, threads.thread_id ASC`,
      )
      .all() as unknown as Array<ThreadRow>;
  }
  const selectedJson = JSON.stringify(selection.threadIds);
  return database
    .prepare(
      `${base}
       WHERE threads.thread_id IN (SELECT value FROM json_each(?))
       ORDER BY threads.project_id ASC, threads.created_at ASC, threads.thread_id ASC`,
    )
    .all(selectedJson) as unknown as Array<ThreadRow>;
}

function selectedIds(selection: ExportSelection, rows: ReadonlyArray<ThreadRow>): Array<string> {
  if (rows.length === 0) fail("invalid-selection", "Thread selection is empty");
  const ids = rows.map((row) => requiredString(row.threadId, "thread ID"));
  if (selection.mode === "threads") {
    const requested = new Set(selection.threadIds);
    if (requested.size !== selection.threadIds.length || ids.some((id) => !requested.has(id))) {
      fail("invalid-selection", "Thread selection contains duplicate or invalid IDs");
    }
    if (ids.length !== requested.size) {
      fail("invalid-selection", "One or more selected threads were not found");
    }
  }
  return ids;
}

function selectMessages(database: DatabaseSync, idsJson: string): Array<MessageRow> {
  return database
    .prepare(
      `SELECT
         message_id AS messageId,
         thread_id AS threadId,
         role,
         text,
         is_streaming AS isStreaming,
         created_at AS createdAt,
         updated_at AS updatedAt,
         CASE WHEN context_json IS NULL THEN 0 ELSE 1 END AS hasContext
       FROM projection_thread_messages
       WHERE thread_id IN (SELECT value FROM json_each(?))
       ORDER BY thread_id ASC, created_at ASC, message_id ASC`,
    )
    .all(idsJson) as unknown as Array<MessageRow>;
}

function selectAttachments(database: DatabaseSync, idsJson: string): Array<AttachmentRow> {
  const invalid = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM projection_thread_messages
       WHERE thread_id IN (SELECT value FROM json_each(?))
         AND attachments_json IS NOT NULL
         AND (json_valid(attachments_json) = 0 OR json_type(attachments_json) <> 'array')`,
    )
    .get(idsJson);
  if (nonNegativeInteger(invalid?.count, "invalid attachment metadata count") > 0) {
    fail("invalid-source", "Source database contains invalid attachment metadata");
  }
  const nonObjects = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM projection_thread_messages AS messages,
         json_each(COALESCE(messages.attachments_json, '[]')) AS attachment
       WHERE messages.thread_id IN (SELECT value FROM json_each(?))
         AND attachment.type <> 'object'`,
    )
    .get(idsJson);
  if (nonNegativeInteger(nonObjects?.count, "invalid attachment count") > 0) {
    fail("invalid-source", "Source database contains invalid attachment entries");
  }
  return database
    .prepare(
      `SELECT
         messages.message_id AS messageId,
         json_extract(attachment.value, '$.id') AS attachmentId,
         json_extract(attachment.value, '$.type') AS type,
         json_extract(attachment.value, '$.name') AS name,
         json_extract(attachment.value, '$.mimeType') AS mimeType,
         json_extract(attachment.value, '$.sizeBytes') AS sizeBytes,
         CASE
           WHEN json_type(attachment.value, '$.source') IS NULL
             OR json_type(attachment.value, '$.source') = 'null'
           THEN 0 ELSE 1
         END AS hasSource
       FROM projection_thread_messages AS messages,
         json_each(COALESCE(messages.attachments_json, '[]')) AS attachment
       WHERE messages.thread_id IN (SELECT value FROM json_each(?))
       ORDER BY messages.thread_id ASC, messages.created_at ASC, messages.message_id ASC,
         attachment.key ASC`,
    )
    .all(idsJson) as unknown as Array<AttachmentRow>;
}

function selectPlans(database: DatabaseSync, idsJson: string): Array<PlanRow> {
  return database
    .prepare(
      `SELECT
         plan_id AS planId,
         thread_id AS threadId,
         plan_markdown AS planMarkdown,
         implemented_at AS implementedAt,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM projection_thread_proposed_plans
       WHERE thread_id IN (SELECT value FROM json_each(?))
       ORDER BY thread_id ASC, created_at ASC, plan_id ASC`,
    )
    .all(idsJson) as unknown as Array<PlanRow>;
}

function readBundleInput(database: DatabaseSync, options: ExportT3ThreadBundleOptions) {
  assertSupportedSchema(database);
  const threadRows = selectThreads(database, options.selection);
  const ids = selectedIds(options.selection, threadRows);
  const idsJson = JSON.stringify(ids);
  assertNoUnmappedDecisions(database, idsJson);
  const messageRows = selectMessages(database, idsJson);
  const attachmentRows = selectAttachments(database, idsJson);
  const planRows = selectPlans(database, idsJson);
  const attachmentsByMessage = new Map<
    string,
    Array<{
      readonly id: string;
      readonly type: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly source?: true;
    }>
  >();
  for (const row of attachmentRows) {
    const messageId = requiredString(row.messageId, "attachment message ID");
    const attachment = {
      id: requiredString(row.attachmentId, "attachment ID"),
      type: requiredString(row.type, "attachment type"),
      name: requiredString(row.name, "attachment name"),
      mimeType: requiredString(row.mimeType, "attachment MIME type"),
      sizeBytes: nonNegativeInteger(row.sizeBytes, "attachment size"),
      ...(sqliteBoolean(row.hasSource, "attachment source marker")
        ? { source: true as const }
        : {}),
    };
    const existing = attachmentsByMessage.get(messageId);
    if (existing) existing.push(attachment);
    else attachmentsByMessage.set(messageId, [attachment]);
  }

  const messagesByThread = new Map<
    string,
    Array<{
      readonly id: never;
      readonly role: "user" | "assistant" | "system";
      readonly text: string;
      readonly streaming: boolean;
      readonly attachments: ReadonlyArray<{
        readonly id: string;
        readonly type: string;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
        readonly source?: true;
      }>;
      readonly context?: true;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>
  >();
  const validRoles = new Set(["user", "assistant", "system"]);
  for (const row of messageRows) {
    const messageId = requiredString(row.messageId, "message ID");
    const threadId = requiredString(row.threadId, "message thread ID");
    const role = requiredString(row.role, "message role");
    if (!validRoles.has(role))
      fail("invalid-source", "Source database contains invalid message role");
    const message = {
      id: messageId as never,
      role: role as "user" | "assistant" | "system",
      text:
        typeof row.text === "string"
          ? row.text
          : fail("invalid-source", "Source database contains invalid message text"),
      streaming: sqliteBoolean(row.isStreaming, "message streaming marker"),
      attachments: attachmentsByMessage.get(messageId) ?? [],
      ...(sqliteBoolean(row.hasContext, "message context marker")
        ? { context: true as const }
        : {}),
      createdAt: requiredString(row.createdAt, "message creation timestamp"),
      updatedAt: requiredString(row.updatedAt, "message update timestamp"),
    };
    const existing = messagesByThread.get(threadId);
    if (existing) existing.push(message);
    else messagesByThread.set(threadId, [message]);
  }

  const plansByThread = new Map<
    string,
    Array<{
      readonly id: never;
      readonly planMarkdown: string;
      readonly implementedAt: string | null;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>
  >();
  for (const row of planRows) {
    const threadId = requiredString(row.threadId, "plan thread ID");
    const plan = {
      id: requiredString(row.planId, "plan ID") as never,
      planMarkdown: requiredString(row.planMarkdown, "plan markdown"),
      implementedAt: nullableString(row.implementedAt, "plan implementation timestamp"),
      createdAt: requiredString(row.createdAt, "plan creation timestamp"),
      updatedAt: requiredString(row.updatedAt, "plan update timestamp"),
    };
    const existing = plansByThread.get(threadId);
    if (existing) existing.push(plan);
    else plansByThread.set(threadId, [plan]);
  }

  return {
    entries: threadRows.map((row) => {
      const threadId = requiredString(row.threadId, "thread ID");
      const projectId = requiredString(row.projectId, "project ID");
      return {
        project: {
          id: projectId as never,
          title: requiredString(row.projectTitle, "project title"),
        },
        thread: {
          id: threadId as never,
          projectId: projectId as never,
          title: requiredString(row.title, "thread title"),
          modelSelection: parseModelSelection(row.modelSelectionJson) as never,
          runtimeMode: requiredString(row.runtimeMode, "runtime mode") as never,
          interactionMode: requiredString(row.interactionMode, "interaction mode") as never,
          branch: nullableString(row.branch, "thread branch"),
          worktreePath: sqliteBoolean(row.hasWorktreePath, "worktree marker") ? true : null,
          messages: messagesByThread.get(threadId) ?? [],
          proposedPlans: plansByThread.get(threadId) ?? [],
          activities: { length: nonNegativeInteger(row.activityCount, "activity count") },
          checkpoints: { length: nonNegativeInteger(row.checkpointCount, "checkpoint count") },
          session: nonNegativeInteger(row.sessionCount, "session count") > 0 ? true : null,
          createdAt: requiredString(row.createdAt, "thread creation timestamp"),
          updatedAt: requiredString(row.updatedAt, "thread update timestamp"),
        },
      };
    }),
  };
}

function writeExclusive(outputPath: string, contents: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = NodeFS.openSync(outputPath, "wx", 0o600);
    NodeFS.writeFileSync(descriptor, contents, "utf8");
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        NodeFS.closeSync(descriptor);
      } finally {
        descriptor = undefined;
        NodeFS.rmSync(outputPath, { force: true });
      }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("output-exists", "Output file already exists");
    }
    fail("output-failed", "Failed to create the output file");
  } finally {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
  }
}

export function exportT3ThreadBundle(
  options: ExportT3ThreadBundleOptions,
): ExportT3ThreadBundleResult {
  if (NodePath.resolve(options.databasePath) === NodePath.resolve(options.outputPath)) {
    fail("invalid-arguments", "Database and output paths must be different");
  }
  const database = (() => {
    try {
      return new DatabaseSync(options.databasePath, { readOnly: true });
    } catch {
      return fail("invalid-source", "Failed to open the source database read-only");
    }
  })();
  let input: ReturnType<typeof readBundleInput> | undefined;
  try {
    database.exec("PRAGMA query_only = ON; BEGIN DEFERRED TRANSACTION");
    input = readBundleInput(database, options);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The read transaction may already have failed before BEGIN completed.
    }
    if (error instanceof OfflineThreadBundleExportError) throw error;
    fail("invalid-source", "Failed to read a consistent source database snapshot");
  } finally {
    database.close();
  }
  if (input === undefined) {
    return fail("invalid-source", "Failed to read a consistent source database snapshot");
  }

  let serialized: string;
  let exportedMessageCount: number;
  try {
    const bundle = buildThreadBundle({
      bundleId: options.bundleId ?? `offline-${NodeCrypto.randomUUID()}`,
      exportedAt: options.exportedAt ?? DateTime.formatIso(DateTime.nowUnsafe()),
      sourceEnvironmentId: options.environmentId,
      entries: input.entries,
    });
    exportedMessageCount = bundle.threads.reduce(
      (count, thread) => count + thread.messages.length,
      0,
    );
    serialized = serializeThreadBundle(bundle);
    // Serialization normalizes the in-memory object but does not decode it
    // against the wire schema. Validate the exact bytes before creating the
    // destination so source rows with incompatible enum/metadata values fail
    // closed without leaving a partial file behind.
    parseThreadBundleJson(serialized);
  } catch {
    return fail("invalid-source", "Source database contains invalid Thread Bundle data");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_THREAD_BUNDLE_BYTES) {
    return fail(
      "output-too-large",
      "Thread Bundle exceeds the 5 MB import limit; select fewer threads and try again",
    );
  }
  writeExclusive(options.outputPath, serialized);
  return { threadCount: input.entries.length, messageCount: exportedMessageCount };
}

export function parseExportT3ThreadBundleArgs(
  args: ReadonlyArray<string>,
): ExportT3ThreadBundleOptions {
  let databasePath: string | undefined;
  let environmentId: string | undefined;
  let outputPath: string | undefined;
  let open = false;
  const threadIds: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const takeValue = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        return fail("invalid-arguments", `Missing value for ${argument}`);
      }
      index += 1;
      return value;
    };
    if (argument === "--database") databasePath = takeValue();
    else if (argument === "--environment-id") environmentId = takeValue();
    else if (argument === "--output") outputPath = takeValue();
    else if (argument === "--open") open = true;
    else if (argument === "--thread") {
      threadIds.push(
        ...takeValue()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    } else fail("invalid-arguments", "Unknown command-line argument");
  }
  if (!databasePath || !environmentId || !outputPath) {
    return fail("invalid-arguments", "--database, --environment-id, and --output are required");
  }
  if (open === threadIds.length > 0) {
    fail("invalid-arguments", "Choose exactly one of --open or --thread");
  }
  return {
    databasePath,
    environmentId,
    outputPath,
    selection: open ? { mode: "open" } : { mode: "threads", threadIds },
  };
}

function runCli(): void {
  try {
    const result = exportT3ThreadBundle(parseExportT3ThreadBundleArgs(process.argv.slice(2)));
    process.stdout.write(
      `Exported ${result.threadCount} threads and ${result.messageCount} messages.\n`,
    );
  } catch (error) {
    const message =
      error instanceof OfflineThreadBundleExportError
        ? error.message
        : "Thread Bundle export failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) runCli();
