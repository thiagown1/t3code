import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Private recovery data. The portable envelope deliberately excludes provider cursors.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_provider_handoff_source_bindings (
      handoff_id TEXT PRIMARY KEY REFERENCES thread_provider_handoffs(handoff_id) ON DELETE CASCADE,
      binding_json TEXT NOT NULL CHECK (json_valid(binding_json))
    ) STRICT
  `;
});
