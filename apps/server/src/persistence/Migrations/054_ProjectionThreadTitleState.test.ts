import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("054_ProjectionThreadTitleState", (it) => {
  it.effect("adds nullable title state after the fork migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      const now = "2026-09-15T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.6-sol"}', 'full-access', ${now}, ${now}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 54 });
      const migrated = yield* sql<{ readonly titleState: string | null }>`
        SELECT title_state_json AS "titleState"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(migrated, [{ titleState: null }]);
    }),
  );
});
