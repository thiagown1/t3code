import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateDeliveryStatus from "./052_ProjectionThreadsDeliveryStatus.ts";

it.layer(NodeSqliteClient.layerMemory())("052_ProjectionThreadsDeliveryStatus", (it) => {
  it.effect("adds an empty delivery gate without changing existing thread timestamps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      const now = "2026-09-14T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.6-sol"}', 'full-access', ${now}, ${now}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });
      const migrated = yield* sql<{
        readonly deliveryStatus: string | null;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT delivery_status AS "deliveryStatus", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(migrated, [{ deliveryStatus: null, createdAt: now, updatedAt: now }]);

      yield* sql`UPDATE projection_threads SET delivery_status = 'waiting-deploy' WHERE thread_id = 'thread-1'`;
      yield* migrateDeliveryStatus;
      const rerun = yield* sql<{ readonly deliveryStatus: string | null }>`
        SELECT delivery_status AS "deliveryStatus" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rerun, [{ deliveryStatus: "waiting-deploy" }]);
    }),
  );
});
