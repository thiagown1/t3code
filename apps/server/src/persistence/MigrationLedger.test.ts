import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { FORK_MIGRATION_ID_FLOOR, reconcileLegacyMigrationIds } from "./MigrationLedger.ts";

/** The layer shares one in-memory database across the file; start each case clean. */
const dropLedger = Effect.fn(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS effect_sql_migrations`;
});

const createLedger = Effect.fn(function* (
  rows: ReadonlyArray<readonly [id: number, name: string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* dropLedger();
  yield* sql`
    CREATE TABLE IF NOT EXISTS effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;
  for (const [id, name] of rows) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  }
});

const readLedger = Effect.fn(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
    SELECT migration_id AS "migrationId", name FROM effect_sql_migrations
    WHERE migration_id >= 50 ORDER BY migration_id
  `;
  return rows.map((row) => [Number(row.migrationId), row.name] as const);
});

/** The applied set the developer's FirstMate database carried before the renumbering. */
const LEGACY_APPLIED = [
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadsDeliveryStatus"],
  [53, "ProjectionProjectsFirstMate"],
  [54, "ProjectionThreadTitleState"],
  [55, "ProjectionThreadsDeliveryStatusReconciliation"],
  [56, "ThreadProviderHandoffs"],
] as const;

it.layer(NodeSqliteClient.layerMemory())("reconcileLegacyMigrationIds", (it) => {
  it.effect("is a no-op when the ledger table does not exist yet", () =>
    Effect.gen(function* () {
      yield* dropLedger();
      assert.deepEqual(yield* reconcileLegacyMigrationIds(), []);
    }),
  );

  it.effect("moves a fully applied legacy fork ledger onto the current numbering", () =>
    Effect.gen(function* () {
      yield* createLedger(LEGACY_APPLIED);
      yield* reconcileLegacyMigrationIds();

      assert.deepEqual(yield* readLedger(), [
        [51, "ProjectionThreadMessageContext"],
        [52, "ProjectionThreadTitleState"],
        [900, "ProjectionThreadsDeliveryStatus"],
        [901, "ProjectionProjectsFirstMate"],
        [902, "ProjectionThreadsDeliveryStatusReconciliation"],
        [903, "ThreadProviderHandoffs"],
      ]);
    }),
  );

  it.effect("leaves the upstream lane free to grow past the fork's ids", () =>
    Effect.gen(function* () {
      yield* createLedger(LEGACY_APPLIED);
      yield* reconcileLegacyMigrationIds();
      const ledger = yield* readLedger();
      const highest = (lane: (id: number) => boolean) =>
        ledger.filter(([id]) => lane(id)).reduce((max, [id]) => (id > max ? id : max), 0);

      // Upstream's watermark must sit at 52 so every upstream migration after it
      // is still pending, no matter how high the fork's own ids have climbed.
      assert.equal(
        highest((id) => id < FORK_MIGRATION_ID_FLOOR),
        52,
      );
      assert.equal(
        highest((id) => id >= FORK_MIGRATION_ID_FLOOR),
        903,
      );
    }),
  );

  it.effect("reconciles a ledger that stopped part way through the fork's migrations", () =>
    Effect.gen(function* () {
      yield* createLedger(LEGACY_APPLIED.slice(0, 4));
      yield* reconcileLegacyMigrationIds();

      assert.deepEqual(yield* readLedger(), [
        [51, "ProjectionThreadMessageContext"],
        [52, "ProjectionThreadTitleState"],
        [900, "ProjectionThreadsDeliveryStatus"],
        [901, "ProjectionProjectsFirstMate"],
      ]);
    }),
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      yield* createLedger(LEGACY_APPLIED);
      yield* reconcileLegacyMigrationIds();
      const once = yield* readLedger();
      assert.deepEqual(yield* reconcileLegacyMigrationIds(), []);
      assert.deepEqual(yield* readLedger(), once);
    }),
  );

  it.effect("leaves an upstream-lineage ledger untouched", () =>
    Effect.gen(function* () {
      const upstream = [
        [51, "ProjectionThreadMessageContext"],
        [52, "ProjectionThreadTitleState"],
        [53, "PullRequestFilesViewed"],
      ] as const;
      yield* createLedger(upstream);
      assert.deepEqual(yield* reconcileLegacyMigrationIds(), []);
      assert.deepEqual(
        yield* readLedger(),
        upstream.map(([id, name]) => [id, name] as const),
      );
    }),
  );

  it.effect("leaves rows another lineage wrote under the same ids alone", () =>
    Effect.gen(function* () {
      const foreign = [
        [52, "SomeOtherForkMigration"],
        [54, "AnotherForkMigration"],
      ] as const;
      yield* createLedger(foreign);
      assert.deepEqual(yield* reconcileLegacyMigrationIds(), []);
      assert.deepEqual(
        yield* readLedger(),
        foreign.map(([id, name]) => [id, name] as const),
      );
    }),
  );

  it.effect("refuses to overwrite a slot that is already taken", () =>
    Effect.gen(function* () {
      // 54 wants to become 52, but 52 is held by a migration this fork does not
      // recognise. Moving it would destroy the occupant, so nothing moves.
      yield* createLedger([
        [52, "SomeOtherForkMigration"],
        [54, "ProjectionThreadTitleState"],
      ]);
      assert.deepEqual(yield* reconcileLegacyMigrationIds(), []);
      assert.deepEqual(yield* readLedger(), [
        [52, "SomeOtherForkMigration"],
        [54, "ProjectionThreadTitleState"],
      ]);
    }),
  );
});
