import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_pull_requests)`;
  if (!columns.some((column) => column.name === "supervision_json")) {
    yield* sql`ALTER TABLE projection_thread_pull_requests ADD COLUMN supervision_json TEXT`;
  }
});
