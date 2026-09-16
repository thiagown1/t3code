import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())(
  "055_ProjectionThreadsDeliveryStatusReconciliation",
  (it) => {
    it.effect("repairs a base that recorded upstream migration 52 as title state", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 51 });
        yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (52, 'ProjectionThreadTitleState')
      `;

        yield* runMigrations();

        const columns = yield* sql<{
          readonly name: string;
          readonly notnull: number;
          readonly dflt_value: string | null;
        }>`
        PRAGMA table_info(projection_threads)
      `;
        const deliveryStatus = columns.find((column) => column.name === "delivery_status");
        const titleState = columns.find((column) => column.name === "title_state_json");
        assert.equal(deliveryStatus?.name, "delivery_status");
        assert.equal(deliveryStatus?.notnull, 0);
        assert.isNull(deliveryStatus?.dflt_value);
        assert.equal(titleState?.name, "title_state_json");

        const migrations = yield* sql<{
          readonly migrationId: number;
          readonly name: string;
        }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id >= 52
        ORDER BY migration_id
      `;
        assert.deepEqual(migrations, [
          { migrationId: 52, name: "ProjectionThreadTitleState" },
          { migrationId: 53, name: "ProjectionProjectsFirstMate" },
          { migrationId: 54, name: "ProjectionThreadTitleState" },
          { migrationId: 55, name: "ProjectionThreadsDeliveryStatusReconciliation" },
        ]);

        /*
         * The full run above uses the manifest loader. Keep the schema assertion
         * after the migration-table assertion so this test proves all pending
         * manifest entries ran, rather than invoking migration 055 directly.
         */
        const verifiedColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
        assert.ok(verifiedColumns.some((column) => column.name === "title_state_json"));
        assert.ok(verifiedColumns.some((column) => column.name === "delivery_status"));
      }),
    );
  },
);
