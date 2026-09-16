import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Upstream used migration ID 52 for title_state_json while the fork used the
// same ID for delivery_status. Reconcile the schema for databases created by
// either lineage; the operation is intentionally idempotent.
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
