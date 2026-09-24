/**
 * Numbering policy for a fork that tracks upstream, and the one-time repair of
 * databases written before the policy existed.
 *
 * Upstream owns the low ids and keeps growing into them (52, 53, 54, ...).
 * Migrations that only exist in this fork live at {@link FORK_MIGRATION_ID_FLOOR}
 * and above, so the two lineages can never claim the same slot again.
 *
 * Two consequences follow, and both live here:
 *
 * 1. Effect's `Migrator` skips every migration whose id is at or below the
 *    single highest recorded id. With a reserved high range that is wrong: once
 *    a fork migration at 900 is recorded, an upstream migration added later at
 *    53 would look "already applied" and be silently skipped forever. We keep
 *    watermark semantics — an applied id is never revisited — but track one
 *    watermark per lane. That is precisely what "reserved range" means, and it
 *    is why {@link runPendingMigrations} exists instead of `Migrator.make`.
 *
 * 2. Databases written before the renumbering recorded the fork's migrations
 *    under upstream's ids, including one row where upstream's
 *    `ProjectionThreadTitleState` was recorded as 54 rather than 52.
 *    {@link reconcileLegacyMigrationIds} rewrites those rows to the current
 *    numbering before anything reads a watermark.
 */

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Ids at or above this belong to this fork; below it belongs to upstream. */
export const FORK_MIGRATION_ID_FLOOR = 900;

const MIGRATIONS_TABLE = "effect_sql_migrations";

export type MigrationEntry = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<unknown, SqlError, SqlClient.SqlClient>,
];

/**
 * Rows this fork once wrote under upstream's ids, keyed by the pair that
 * identifies them unambiguously. A row is only rewritten when its recorded name
 * matches, so a database from upstream or from another fork that happens to use
 * the same id is left alone.
 *
 * Ordered so every id that moves into the reserved range is vacated before
 * `ProjectionThreadTitleState` reclaims 52.
 */
const LEGACY_MIGRATION_IDS: ReadonlyArray<
  readonly [legacyId: number, name: string, currentId: number]
> = [
  [52, "ProjectionThreadsDeliveryStatus", 900],
  [53, "ProjectionProjectsFirstMate", 901],
  [55, "ProjectionThreadsDeliveryStatusReconciliation", 902],
  [56, "ThreadProviderHandoffs", 903],
  [57, "PullRequestSupervision", 904],
  [54, "ProjectionThreadTitleState", 52],
];

/**
 * Rewrite pre-renumbering ledger rows in place.
 *
 * Without this, a fork database either never runs upstream's migration 53
 * (its id already looks applied) or tries to re-run `ProjectionThreadTitleState`
 * (recorded as 54, so 52 looks pending) and fails on a duplicate column.
 *
 * Idempotent, and a no-op on a fresh database, on a database that has already
 * been reconciled, and on a database whose rows this fork did not write. Rows
 * are moved, never dropped: a slot that is already taken is left untouched
 * rather than overwritten.
 */
export const reconcileLegacyMigrationIds = Effect.fn("reconcileLegacyMigrationIds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledgerExists = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}
  `.withoutTransform;
  if (ledgerExists.length === 0) {
    return [];
  }

  const rewritten: Array<readonly [legacyId: number, currentId: number, name: string]> = [];
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(MIGRATIONS_TABLE)}
  `.withoutTransform;
  const occupied = new Map(rows.map((row) => [Number(row.migration_id), row.name]));

  for (const [legacyId, name, currentId] of LEGACY_MIGRATION_IDS) {
    if (legacyId === currentId) continue;
    if (occupied.get(legacyId) !== name) continue;
    // Never clobber a slot somebody else already owns; leaving the legacy row in
    // place is recoverable, losing the occupant is not.
    if (occupied.has(currentId)) continue;

    yield* sql`
      UPDATE ${sql(MIGRATIONS_TABLE)}
      SET migration_id = ${currentId}
      WHERE migration_id = ${legacyId} AND name = ${name}
    `;
    occupied.delete(legacyId);
    occupied.set(currentId, name);
    rewritten.push([legacyId, currentId, name]);
  }

  if (rewritten.length > 0) {
    yield* Effect.log("Reconciled legacy migration ids").pipe(
      Effect.annotateLogs({
        rewritten: rewritten.map(([from, to, name]) => `${from}_${name} -> ${to}_${name}`),
      }),
    );
  }
  return rewritten;
});

/**
 * Run every manifest entry that its lane's watermark has not passed.
 *
 * Mirrors `Migrator.make` for SQLite — same table, same insert-then-run
 * ordering so a concurrent runner collides on the primary key and backs off
 * instead of applying a migration twice — but resolves "pending" per lane. The
 * ledger is reconciled first so the watermarks are read from current ids.
 */
export const runPendingMigrations = Effect.fn("runPendingMigrations")(function* (
  entries: ReadonlyArray<MigrationEntry>,
) {
  const sql = yield* SqlClient.SqlClient;

  if (new Set(entries.map(([id]) => id)).size !== entries.length) {
    return yield* Effect.die("Found duplicate migration id's");
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(MIGRATIONS_TABLE)} (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;
  yield* reconcileLegacyMigrationIds();

  const run = Effect.gen(function* () {
    const applied = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id FROM ${sql(MIGRATIONS_TABLE)}
    `.withoutTransform;
    const appliedIds = applied.map((row) => Number(row.migration_id));
    const watermark = (lane: (id: number) => boolean) =>
      appliedIds.filter(lane).reduce((highest, id) => (id > highest ? id : highest), 0);
    const upstreamWatermark = watermark((id) => id < FORK_MIGRATION_ID_FLOOR);
    const forkWatermark = watermark((id) => id >= FORK_MIGRATION_ID_FLOOR);

    const pending = entries.filter(
      ([id]) => id > (id >= FORK_MIGRATION_ID_FLOOR ? forkWatermark : upstreamWatermark),
    );
    if (pending.length === 0) {
      return [];
    }

    yield* sql`
      INSERT INTO ${sql(MIGRATIONS_TABLE)} ${sql.insert(
        pending.map(([migration_id, name]) => ({ migration_id, name })),
      )}
    `.withoutTransform;

    yield* Effect.forEach(
      pending,
      ([id, name, migration]) =>
        Effect.catch(migration, (error) =>
          Effect.die(new Error(`Migration "${id}_${name}" failed`, { cause: error })),
        ).pipe(
          Effect.annotateLogs({ migration_id: String(id), migration_name: name }),
          Effect.withSpan(`Migrator ${id}_${name}`),
        ),
      { discard: true },
    );

    return pending.map(([id, name]) => [id, name] as const);
  });

  return yield* sql.withTransaction(run).pipe(
    // A second process inserting the same ids first means it is migrating right
    // now; let it finish rather than racing it.
    Effect.catchIf(
      (error) =>
        error._tag === "SqlError" &&
        (error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation"),
      () => Effect.as(Effect.logDebug("Migrations already running"), []),
    ),
  );
});
