import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const HASH = "a".repeat(64);

it.layer(NodeSqliteClient.layerMemory())("903_ThreadProviderHandoffs", (it) => {
  it.effect("creates durable handoff tables with active-thread and envelope constraints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 902 });
      const migrated = yield* runMigrations({ toMigrationInclusive: 903 });
      assert.deepEqual(
        migrated.map(([id]) => id),
        [903],
      );
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 903 }), []);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('thread_provider_handoffs', 'thread_provider_handoff_envelopes')
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((row) => row.name),
        ["thread_provider_handoff_envelopes", "thread_provider_handoffs"],
      );

      yield* sql`
        INSERT INTO thread_provider_handoffs (
          handoff_id, thread_id, state, context_hash, envelope_hash,
          record_json, created_at, updated_at
        ) VALUES (
          'handoff-one', 'thread-one', 'prepared', ${HASH}, ${HASH},
          '{}', '2026-09-16T12:00:00.000Z', '2026-09-16T12:00:00.000Z'
        )
      `;
      const duplicateActive = yield* Effect.result(sql`
        INSERT INTO thread_provider_handoffs (
          handoff_id, thread_id, state, context_hash, envelope_hash,
          record_json, created_at, updated_at
        ) VALUES (
          'handoff-two', 'thread-one', 'prepared', ${HASH}, ${HASH},
          '{}', '2026-09-16T12:00:01.000Z', '2026-09-16T12:00:01.000Z'
        )
      `);
      assert.equal(duplicateActive._tag, "Failure");

      yield* sql`UPDATE thread_provider_handoffs SET state = 'failed' WHERE handoff_id = 'handoff-one'`;
      yield* sql`
        INSERT INTO thread_provider_handoffs (
          handoff_id, thread_id, state, context_hash, envelope_hash,
          record_json, created_at, updated_at
        ) VALUES (
          'handoff-two', 'thread-one', 'prepared', ${HASH}, ${HASH},
          '{}', '2026-09-16T12:00:01.000Z', '2026-09-16T12:00:01.000Z'
        )
      `;

      const orphanEnvelope = yield* Effect.result(sql`
        INSERT INTO thread_provider_handoff_envelopes (
          handoff_id, envelope_hash, envelope_json, created_at
        ) VALUES (
          'missing-handoff', ${HASH}, '{}', '2026-09-16T12:00:02.000Z'
        )
      `);
      assert.equal(orphanEnvelope._tag, "Failure");
    }),
  );
});
