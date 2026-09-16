import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - fixtures verify byte identity and exclusive output
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - fixture paths are synchronous and process-local
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { parseThreadBundleJson } from "@t3tools/shared/threadBundle";

import {
  exportT3ThreadBundle,
  OfflineThreadBundleExportError,
  parseExportT3ThreadBundleArgs,
} from "./export-t3-thread-bundle.ts";

const NOW = "2026-09-16T12:00:00.000Z";
const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-offline-export-"));
  temporaryDirectories.push(directory);
  const databasePath = NodePath.join(directory, "source.sqlite");
  const outputPath = NodePath.join(directory, "bundle.json");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      model_selection_json TEXT,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attachments_json TEXT,
      context_json TEXT
    );
    CREATE TABLE projection_thread_proposed_plans (
      plan_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      plan_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      implemented_at TEXT,
      implementation_thread_id TEXT
    );
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY
    );
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      checkpoint_turn_count INTEGER
    );
  `);
  database
    .prepare("INSERT INTO projection_projects (project_id, title) VALUES (?, ?)")
    .run("project-source", "Source project");
  return { directory, databasePath, outputPath, database };
}

function insertThread(
  database: DatabaseSync,
  input: {
    readonly id?: string;
    readonly modelSelection?: string | null;
    readonly archivedAt?: string | null;
    readonly deletedAt?: string | null;
    readonly worktreePath?: string | null;
  } = {},
) {
  const id = input.id ?? "thread-open";
  database
    .prepare(
      `INSERT INTO projection_threads (
        thread_id, project_id, title, branch, worktree_path, model_selection_json,
        runtime_mode, interaction_mode, created_at, updated_at, archived_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "project-source",
      `Thread ${id}`,
      "main",
      input.worktreePath ?? null,
      input.modelSelection === undefined
        ? JSON.stringify({ instanceId: "codex-work", model: "gpt-5.4" })
        : input.modelSelection,
      "full-access",
      "default",
      NOW,
      NOW,
      input.archivedAt ?? null,
      input.deletedAt ?? null,
    );
  return id;
}

function insertMessage(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly threadId: string;
    readonly text?: string;
    readonly streaming?: boolean;
    readonly attachments?: unknown;
    readonly context?: unknown;
  },
) {
  database
    .prepare(
      `INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
        attachments_json, context_json
      ) VALUES (?, ?, NULL, 'user', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.threadId,
      input.text ?? `message ${input.id}`,
      input.streaming ? 1 : 0,
      NOW,
      NOW,
      input.attachments === undefined ? null : JSON.stringify(input.attachments),
      input.context === undefined ? null : JSON.stringify(input.context),
    );
}

function close(database: DatabaseSync): void {
  database.close();
}

function hashFile(path: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

function writeProjectIdentities(directory: string, projects: ReadonlyArray<unknown>): string {
  const path = NodePath.join(directory, "project-identities.json");
  NodeFS.writeFileSync(path, JSON.stringify({ projects }), "utf8");
  return path;
}

const turboStationIdentity = {
  sourceProjectId: "project-source",
  repositoryIdentity: {
    canonicalKey: "github.com/thiagown1/turbo_station",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/thiagown1/turbo_station.git",
    },
    provider: "github",
    owner: "thiagown1",
    name: "turbo_station",
  },
} as const;

describe("offline T3 Thread Bundle exporter", () => {
  it("exports open official threads with sourceProjectId and all proposed plans", () => {
    const { database, databasePath, outputPath } = fixture();
    const threadId = insertThread(database);
    insertThread(database, { id: "thread-archived", archivedAt: NOW });
    insertThread(database, { id: "thread-deleted", deletedAt: NOW });
    insertMessage(database, { id: "message-1", threadId, text: "portable text" });
    database
      .prepare(
        `INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, plan_markdown, created_at, updated_at, implemented_at
        ) VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run("plan-1", threadId, "Do the safe thing", NOW, NOW);
    close(database);

    const result = exportT3ThreadBundle({
      databasePath,
      environmentId: "official-source",
      outputPath,
      selection: { mode: "open" },
      bundleId: "fixture-bundle",
      exportedAt: NOW,
    });
    const bundle = parseThreadBundleJson(NodeFS.readFileSync(outputPath, "utf8"));

    expect(result).toEqual({ threadCount: 1, messageCount: 1 });
    expect(bundle.threads).toHaveLength(1);
    expect(bundle.threads[0]?.project).toEqual({
      sourceProjectId: "project-source",
      title: "Source project",
    });
    expect(bundle.threads[0]?.messages[0]?.text).toBe("portable text");
    expect(bundle.threads[0]?.proposedPlans).toHaveLength(1);
  });

  it("applies an exact, schema-validated repository identity override", () => {
    const { database, databasePath, outputPath, directory } = fixture();
    insertThread(database);
    close(database);
    const projectIdentitiesPath = writeProjectIdentities(directory, [turboStationIdentity]);

    exportT3ThreadBundle({
      databasePath,
      environmentId: "official-source",
      outputPath,
      projectIdentitiesPath,
      selection: { mode: "open" },
      bundleId: "fixture-bundle",
      exportedAt: NOW,
    });

    expect(
      parseThreadBundleJson(NodeFS.readFileSync(outputPath, "utf8")).threads[0]?.project,
    ).toEqual({
      sourceProjectId: "project-source",
      title: "Source project",
      repositoryCanonicalKey: "github.com/thiagown1/turbo_station",
      repositoryProvider: "github",
      repositoryOwner: "thiagown1",
      repositoryName: "turbo_station",
    });
  });

  it("accepts an explicit null identity for a selected non-Git project", () => {
    const { database, databasePath, outputPath, directory } = fixture();
    insertThread(database);
    close(database);
    const projectIdentitiesPath = writeProjectIdentities(directory, [
      { sourceProjectId: "project-source", repositoryIdentity: null },
    ]);

    exportT3ThreadBundle({
      databasePath,
      environmentId: "official-source",
      outputPath,
      projectIdentitiesPath,
      selection: { mode: "open" },
      bundleId: "fixture-bundle",
      exportedAt: NOW,
    });

    expect(
      parseThreadBundleJson(NodeFS.readFileSync(outputPath, "utf8")).threads[0]?.project,
    ).toEqual({ sourceProjectId: "project-source", title: "Source project" });
  });

  it.each([
    ["missing", []],
    ["extra", [{ sourceProjectId: "project-extra", repositoryIdentity: null }]],
    ["unexpected field", [{ ...turboStationIdentity, unexpected: true }]],
    [
      "duplicate",
      [
        { sourceProjectId: "project-source", repositoryIdentity: null },
        { sourceProjectId: "project-source", repositoryIdentity: null },
      ],
    ],
    [
      "canonical mismatch",
      [
        {
          ...turboStationIdentity,
          repositoryIdentity: {
            ...turboStationIdentity.repositoryIdentity,
            canonicalKey: "github.com/other/repo",
          },
        },
      ],
    ],
    [
      "remote credentials",
      [
        {
          ...turboStationIdentity,
          repositoryIdentity: {
            ...turboStationIdentity.repositoryIdentity,
            locator: {
              ...turboStationIdentity.repositoryIdentity.locator,
              remoteUrl: "https://token:secret@github.com/thiagown1/turbo_station.git",
            },
          },
        },
      ],
    ],
  ])("rejects %s project identity metadata without output", (_reason, projects) => {
    const { database, databasePath, outputPath, directory } = fixture();
    insertThread(database);
    close(database);
    const projectIdentitiesPath = writeProjectIdentities(directory, projects);

    expect(() =>
      exportT3ThreadBundle({
        databasePath,
        environmentId: "official-source",
        outputPath,
        projectIdentitiesPath,
        selection: { mode: "open" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-source" }));
    expect(NodeFS.existsSync(outputPath)).toBe(false);
  });

  it("exports more than 200 messages without a best-effort history limit", () => {
    const { database, databasePath, outputPath } = fixture();
    const threadId = insertThread(database);
    database.exec("BEGIN");
    for (let index = 0; index < 205; index += 1) {
      insertMessage(database, { id: `message-${String(index).padStart(3, "0")}`, threadId });
    }
    database.exec("COMMIT");
    close(database);

    const result = exportT3ThreadBundle({
      databasePath,
      environmentId: "official-source",
      outputPath,
      selection: { mode: "threads", threadIds: [threadId] },
      bundleId: "fixture-bundle",
      exportedAt: NOW,
    });
    const bundle = parseThreadBundleJson(NodeFS.readFileSync(outputPath, "utf8"));

    expect(result.messageCount).toBe(205);
    expect(bundle.threads[0]?.messages).toHaveLength(205);
  });

  it("sanitizes streaming, attachments, context, and runtime-only metadata as omissions", () => {
    const { database, databasePath, outputPath } = fixture();
    const threadId = insertThread(database, { worktreePath: "never-export-this-path" });
    insertMessage(database, { id: "streaming", threadId, streaming: true });
    insertMessage(database, {
      id: "portable",
      threadId,
      context: { private: "never-export-this-context" },
      attachments: [
        {
          id: "attachment-1",
          type: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 12,
          source: { path: "never-export-this-source" },
          content: "never-export-this-content",
        },
      ],
    });
    database
      .prepare("INSERT INTO projection_thread_activities (activity_id, thread_id) VALUES (?, ?)")
      .run("activity-1", threadId);
    database.prepare("INSERT INTO projection_thread_sessions (thread_id) VALUES (?)").run(threadId);
    database
      .prepare(
        "INSERT INTO projection_turns (row_id, thread_id, checkpoint_turn_count) VALUES (?, ?, ?)",
      )
      .run(1, threadId, 1);
    close(database);

    const result = exportT3ThreadBundle({
      databasePath,
      environmentId: "official-source",
      outputPath,
      selection: { mode: "open" },
      bundleId: "fixture-bundle",
      exportedAt: NOW,
    });
    const exported = NodeFS.readFileSync(outputPath, "utf8");
    const bundle = parseThreadBundleJson(exported);

    expect(result.messageCount).toBe(1);

    expect(bundle.threads[0]?.messages.map((message) => message.sourceMessageId)).toEqual([
      "portable",
    ]);
    expect(bundle.threads[0]?.messages[0]?.attachments[0]).toEqual({
      sourceAttachmentId: "attachment-1",
      type: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 12,
      availability: "reference-only",
    });
    expect(bundle.threads[0]?.omissions).toEqual([
      { kind: "active-streaming-message", count: 1 },
      { kind: "activity", count: 1 },
      { kind: "attachment-content", count: 1 },
      { kind: "attachment-source", count: 1 },
      { kind: "checkpoint", count: 1 },
      { kind: "message-context", count: 1 },
      { kind: "session", count: 1 },
      { kind: "worktree-path", count: 1 },
    ]);
    expect(exported).not.toMatch(/never-export-this-(?:path|context|source|content)/);
  });

  it("keeps the source database byte-identical and refuses to overwrite output", () => {
    const { database, databasePath, outputPath } = fixture();
    insertThread(database);
    close(database);
    const before = hashFile(databasePath);

    exportT3ThreadBundle({
      databasePath,
      environmentId: "official-source",
      outputPath,
      selection: { mode: "open" },
      bundleId: "fixture-bundle",
      exportedAt: NOW,
    });
    const firstOutput = NodeFS.readFileSync(outputPath, "utf8");
    expect(hashFile(databasePath)).toBe(before);
    expect(() =>
      exportT3ThreadBundle({
        databasePath,
        environmentId: "official-source",
        outputPath,
        selection: { mode: "open" },
      }),
    ).toThrow(expect.objectContaining({ code: "output-exists" }));
    expect(NodeFS.readFileSync(outputPath, "utf8")).toBe(firstOutput);
    expect(hashFile(databasePath)).toBe(before);
  });

  it("fails closed for missing thread IDs and invalid model selections", () => {
    const missing = fixture();
    insertThread(missing.database);
    close(missing.database);
    expect(() =>
      exportT3ThreadBundle({
        databasePath: missing.databasePath,
        environmentId: "official-source",
        outputPath: missing.outputPath,
        selection: { mode: "threads", threadIds: ["missing-thread"] },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-selection" }));
    expect(NodeFS.existsSync(missing.outputPath)).toBe(false);

    const invalid = fixture();
    insertThread(invalid.database, { modelSelection: "not-json" });
    close(invalid.database);
    expect(() =>
      exportT3ThreadBundle({
        databasePath: invalid.databasePath,
        environmentId: "official-source",
        outputPath: invalid.outputPath,
        selection: { mode: "open" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-source" }));
    expect(NodeFS.existsSync(invalid.outputPath)).toBe(false);
  });

  it("rejects invalid runtime, timestamps, and source environment IDs before writing", () => {
    const runtime = fixture();
    const runtimeThread = insertThread(runtime.database);
    runtime.database
      .prepare("UPDATE projection_threads SET runtime_mode = ? WHERE thread_id = ?")
      .run("unsupported-runtime", runtimeThread);
    close(runtime.database);
    expect(() =>
      exportT3ThreadBundle({
        databasePath: runtime.databasePath,
        environmentId: "official-source",
        outputPath: runtime.outputPath,
        selection: { mode: "open" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-source" }));
    expect(NodeFS.existsSync(runtime.outputPath)).toBe(false);

    const timestamp = fixture();
    const timestampThread = insertThread(timestamp.database);
    timestamp.database
      .prepare("UPDATE projection_threads SET created_at = ? WHERE thread_id = ?")
      .run("", timestampThread);
    close(timestamp.database);
    expect(() =>
      exportT3ThreadBundle({
        databasePath: timestamp.databasePath,
        environmentId: "official-source",
        outputPath: timestamp.outputPath,
        selection: { mode: "open" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-source" }));
    expect(NodeFS.existsSync(timestamp.outputPath)).toBe(false);

    const environment = fixture();
    insertThread(environment.database);
    close(environment.database);
    expect(() =>
      exportT3ThreadBundle({
        databasePath: environment.databasePath,
        environmentId: "",
        outputPath: environment.outputPath,
        selection: { mode: "open" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-source" }));
    expect(NodeFS.existsSync(environment.outputPath)).toBe(false);
  });

  it("rejects bundles larger than the import limit without writing output", () => {
    const { database, databasePath, outputPath } = fixture();
    const threadId = insertThread(database);
    insertMessage(database, {
      id: "oversized-message",
      threadId,
      text: "x".repeat(5 * 1024 * 1024),
    });
    close(database);

    expect(() =>
      exportT3ThreadBundle({
        databasePath,
        environmentId: "official-source",
        outputPath,
        selection: { mode: "open" },
        bundleId: "fixture-bundle",
        exportedAt: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "output-too-large" }));
    expect(NodeFS.existsSync(outputPath)).toBe(false);
  });

  it("rejects FirstMate decisions instead of silently omitting them", () => {
    const { database, databasePath, outputPath } = fixture();
    insertThread(database);
    database.exec("ALTER TABLE projection_projects ADD COLUMN firstmate_json TEXT");
    database
      .prepare("UPDATE projection_projects SET firstmate_json = ?")
      .run(JSON.stringify({ decisions: [{ id: "decision-1" }] }));
    close(database);

    expect(() =>
      exportT3ThreadBundle({
        databasePath,
        environmentId: "official-source",
        outputPath,
        selection: { mode: "open" },
      }),
    ).toThrow(expect.objectContaining({ code: "unsupported-decisions" }));
    expect(NodeFS.existsSync(outputPath)).toBe(false);
  });

  it("parses repeated and comma-separated thread arguments", () => {
    expect(
      parseExportT3ThreadBundleArgs([
        "--database",
        "source.sqlite",
        "--environment-id",
        "source",
        "--output",
        "bundle.json",
        "--project-identities",
        "identities.json",
        "--thread",
        "one,two",
        "--thread",
        "three",
      ]).selection,
    ).toEqual({ mode: "threads", threadIds: ["one", "two", "three"] });
    expect(
      parseExportT3ThreadBundleArgs([
        "--database",
        "source.sqlite",
        "--environment-id",
        "source",
        "--output",
        "bundle.json",
        "--project-identities",
        "identities.json",
        "--thread",
        "one",
      ]).projectIdentitiesPath,
    ).toBe("identities.json");
    expect(() =>
      parseExportT3ThreadBundleArgs([
        "--database",
        "source.sqlite",
        "--environment-id",
        "source",
        "--output",
        "bundle.json",
        "--open",
        "--thread",
        "one",
      ]),
    ).toThrow(OfflineThreadBundleExportError);
  });
});
