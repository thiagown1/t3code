import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())(
  "902_ProjectionThreadsDeliveryStatusReconciliation",
  (it) => {
    it.effect("adds the fork columns to an upstream-lineage database", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A database that only ever ran upstream's migrations: 52 is recorded
        // under upstream's name, so it must not be attempted again.
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
        assert.equal(deliveryStatus?.name, "delivery_status");
        assert.equal(deliveryStatus?.notnull, 0);
        assert.isNull(deliveryStatus?.dflt_value);
        assert.ok(columns.some((column) => column.name === "title_state_json"));

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
          { migrationId: 53, name: "PullRequestFilesViewed" },
          { migrationId: 900, name: "ProjectionThreadsDeliveryStatus" },
          { migrationId: 901, name: "ProjectionProjectsFirstMate" },
          { migrationId: 902, name: "ProjectionThreadsDeliveryStatusReconciliation" },
          { migrationId: 903, name: "ThreadProviderHandoffs" },
          { migrationId: 904, name: "PullRequestSupervision" },
        ]);
      }),
    );
  },
);
