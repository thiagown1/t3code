import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./904_PullRequestSupervision.ts";
import { ThreadId } from "@t3tools/contracts";
import { make as makeRepository } from "../ProjectionThreadPullRequests.ts";

it.layer(NodeSqliteClient.layerMemory())("PR supervision migration", (it) => {
  it.effect("adds nullable state and preserves it on repeated migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 903 });
      const before = yield* sql<{
        name: string;
      }>`PRAGMA table_info(projection_thread_pull_requests)`;
      expect(before.some((column) => column.name === "supervision_json")).toBe(false);
      yield* migration;
      yield* migration;
      const after = yield* sql<{
        name: string;
        notnull: number;
      }>`PRAGMA table_info(projection_thread_pull_requests)`;
      expect(after.filter((column) => column.name === "supervision_json")).toMatchObject([
        { name: "supervision_json", notnull: 0 },
      ]);
      const repository = yield* makeRepository;
      const row = {
        threadId: ThreadId.make("owner-thread"),
        host: "github.com",
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        source: "agent" as const,
        linkedAt: "2026-09-16T00:00:00.000Z",
        snapshot: null,
        stack: null,
        supervision: {
          owner: "firstmate:00000000-0000-4000-8000-000000000001",
          environmentKey: "environment-a",
          state: "watching" as const,
          headSha: "a".repeat(40),
          baseRef: "main",
          headRef: "feature",
          resumes: 2,
          expiresAt: "2026-09-16T02:00:00.000Z",
          lastResumeKey: "head:needs_work:20",
          lastReason: null,
        },
      };
      yield* repository.upsert(row);
      yield* migration;
      expect(yield* repository.listByThreadId({ threadId: row.threadId })).toEqual([row]);
      const restartedRepository = yield* makeRepository;
      expect(yield* restartedRepository.listByPullRequest(row)).toEqual([row]);
    }),
  );
});
