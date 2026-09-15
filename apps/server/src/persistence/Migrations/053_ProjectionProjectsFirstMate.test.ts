import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateFirstMate from "./053_ProjectionProjectsFirstMate.ts";

it.layer(NodeSqliteClient.layerMemory())("053_ProjectionProjectsFirstMate", (it) => {
  it.effect("adds nullable FirstMate state without inventing data for existing projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      const now = "2026-09-14T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-1', 'Existing project', 'C:/workspace', '[]', ${now}, ${now})
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });
      const migrated = yield* sql<{ readonly firstMate: string | null }>`
        SELECT firstmate_json AS "firstMate"
        FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.deepEqual(migrated, [{ firstMate: null }]);

      yield* sql`UPDATE projection_projects SET firstmate_json = '{"topics":[]}'`;
      yield* migrateFirstMate;
      const rerun = yield* sql<{ readonly firstMate: string | null }>`
        SELECT firstmate_json AS "firstMate"
        FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.deepEqual(rerun, [{ firstMate: '{"topics":[]}' }]);
    }),
  );
});
