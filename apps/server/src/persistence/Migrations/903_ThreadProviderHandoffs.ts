import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_provider_handoffs (
      handoff_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'requested',
        'validating',
        'compacting',
        'prepared',
        'target-starting',
        'target-ready',
        'committing',
        'committed',
        'failed',
        'cancelled',
        'unknown'
      )),
      context_hash TEXT NOT NULL CHECK (
        length(context_hash) = 64 AND context_hash NOT GLOB '*[^a-f0-9]*'
      ),
      envelope_hash TEXT NOT NULL CHECK (
        length(envelope_hash) = 64 AND envelope_hash NOT GLOB '*[^a-f0-9]*'
      ),
      record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_provider_handoff_envelopes (
      handoff_id TEXT PRIMARY KEY REFERENCES thread_provider_handoffs(handoff_id) ON DELETE CASCADE,
      envelope_hash TEXT NOT NULL CHECK (
        length(envelope_hash) = 64 AND envelope_hash NOT GLOB '*[^a-f0-9]*'
      ),
      envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
      created_at TEXT NOT NULL
    ) STRICT
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS thread_provider_handoffs_one_active_per_thread
    ON thread_provider_handoffs(thread_id)
    WHERE state NOT IN ('committed', 'failed', 'cancelled')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS thread_provider_handoffs_recovery
    ON thread_provider_handoffs(updated_at, handoff_id)
    WHERE state NOT IN ('committed', 'failed', 'cancelled')
  `;
});
