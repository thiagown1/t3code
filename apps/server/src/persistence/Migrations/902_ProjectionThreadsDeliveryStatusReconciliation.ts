import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Kept from before the fork reserved its own id range, when upstream and this
// fork both numbered a migration 52 and a database could end up with upstream's
// title state column but none of the fork's. `MigrationLedger.ts` repairs that
// lineage properly now, so this is a belt-and-braces no-op on every database it
// still sees; it stays because dropping an applied migration buys nothing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "delivery_status")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN delivery_status TEXT
    `;
  }
});
