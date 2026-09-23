import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  ThreadProviderHandoffRecord,
  type ThreadProviderHandoffEnvelope,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { sanitizeThreadProviderHandoff } from "@t3tools/shared/threadProviderHandoff";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import migration from "./Migrations/056_ThreadProviderHandoffs.ts";
import sourceBindingMigration from "./Migrations/057_ThreadProviderHandoffSourceBindings.ts";
import {
  layer as ThreadProviderHandoffStoreLive,
  ThreadProviderHandoffStore,
  type ThreadProviderHandoffStored,
} from "./ThreadProviderHandoffStore.ts";

const NOW = "2026-09-16T12:00:00.000Z";
const decodeHandoffRecord = Schema.decodeSync(ThreadProviderHandoffRecord);

function makeStoreLayer<E, R>(sqlite: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* migration;
      yield* sourceBindingMigration;
    }),
  ).pipe(Layer.provideMerge(sqlite));
  return ThreadProviderHandoffStoreLive.pipe(Layer.provideMerge(migrated));
}

const memoryLayer = makeStoreLayer(NodeSqliteClient.layerMemory());

function makeEnvelope(input: {
  readonly handoffId: string;
  readonly threadId?: string;
  readonly targetModel?: string;
  readonly createdAt?: string;
}): ThreadProviderHandoffEnvelope {
  return sanitizeThreadProviderHandoff({
    handoffId: input.handoffId,
    threadId: ThreadId.make(input.threadId ?? "thread-handoff"),
    source: {
      providerInstanceId: "codex-primary",
      driver: "codex",
      model: "gpt-5.4",
    },
    target: {
      providerInstanceId: "claude-primary",
      driver: "claudeAgent",
      model: input.targetModel ?? "claude-opus-4-6",
    },
    reason: "quota",
    sequence: 23,
    sourceTurnId: "turn-source",
    projectId: ProjectId.make("project-handoff"),
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/handoff",
    messages: [
      {
        id: "message-source",
        role: "assistant",
        text: "Prepared context",
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [],
    resolvedDecisions: [],
    createdAt: input.createdAt ?? NOW,
  });
}

function makePrepared(input: {
  readonly handoffId: string;
  readonly threadId?: string;
  readonly targetModel?: string;
  readonly createdAt?: string;
}): ThreadProviderHandoffStored {
  const envelope = makeEnvelope(input);
  const record = decodeHandoffRecord({
    schemaVersion: envelope.schemaVersion,
    handoffId: envelope.handoffId,
    threadId: envelope.threadId,
    source: envelope.source,
    target: envelope.target,
    reason: envelope.reason,
    sequence: envelope.sequence,
    ...(envelope.sourceTurnId === undefined ? {} : { sourceTurnId: envelope.sourceTurnId }),
    state: "prepared",
    contextHash: envelope.contextHash,
    envelopeHash: envelope.envelopeHash,
    omissions: envelope.omissions,
    createdAt: envelope.createdAt,
    updatedAt: envelope.createdAt,
  });
  return { record, envelope };
}

function assertConflict(result: Result.Result<unknown, unknown>, reason: string): void {
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure") {
    assert.deepInclude(result.failure, {
      _tag: "ThreadProviderHandoffStoreConflictError",
      reason,
    });
  }
}

it.layer(memoryLayer)("ThreadProviderHandoffStore", (it) => {
  it.effect("stores record and envelope atomically and accepts an identical retry", () =>
    Effect.gen(function* () {
      const store = yield* ThreadProviderHandoffStore;
      const prepared = makePrepared({ handoffId: "handoff-happy" });

      assert.deepEqual(yield* store.createPrepared(prepared), prepared);
      assert.deepEqual(yield* store.createPrepared(prepared), prepared);

      const persisted = yield* store.getByHandoffId(prepared.record.handoffId);
      assert.ok(Option.isSome(persisted));
      assert.deepEqual(persisted.value, prepared);
      assert.deepEqual(yield* store.listRecoverable(), [prepared]);
    }),
  );

  it.effect("rejects divergent ids, concurrent active handoffs, and rolls back split inserts", () =>
    Effect.gen(function* () {
      const store = yield* ThreadProviderHandoffStore;
      const sql = yield* SqlClient.SqlClient;
      const validBeforeForgery = makePrepared({
        handoffId: "handoff-forged",
        threadId: "thread-forged",
      });
      const forged: ThreadProviderHandoffStored = {
        record: validBeforeForgery.record,
        envelope: {
          ...validBeforeForgery.envelope,
          context: {
            ...validBeforeForgery.envelope.context,
            messages: validBeforeForgery.envelope.context.messages.map((message) => ({
              ...message,
              text: "Forged context with retained hashes",
            })),
          },
        },
      };
      assertConflict(yield* Effect.result(store.createPrepared(forged)), "invalid-payload");
      const forgedRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_provider_handoffs
        WHERE handoff_id = 'handoff-forged'
      `;
      assert.deepEqual(forgedRows, [{ count: 0 }]);

      const prepared = makePrepared({
        handoffId: "handoff-conflict",
        threadId: "thread-conflict",
      });
      yield* store.createPrepared(prepared);

      assertConflict(
        yield* Effect.result(
          store.transition({
            handoffId: prepared.record.handoffId,
            expectedState: "prepared",
            expectedEnvelopeHash: prepared.envelope.envelopeHash,
            nextState: "target-starting",
            updatedAt: "not-an-iso-date" as never,
          }),
        ),
        "invalid-payload",
      );

      assertConflict(
        yield* Effect.result(
          store.createPrepared(
            makePrepared({
              handoffId: "handoff-conflict",
              threadId: "thread-conflict",
              targetModel: "claude-sonnet-4-5",
            }),
          ),
        ),
        "payload-mismatch",
      );
      assertConflict(
        yield* Effect.result(
          store.createPrepared(
            makePrepared({ handoffId: "handoff-other", threadId: "thread-conflict" }),
          ),
        ),
        "active-thread-handoff",
      );

      yield* sql`
        CREATE TRIGGER reject_atomic_envelope
        BEFORE INSERT ON thread_provider_handoff_envelopes
        WHEN NEW.handoff_id = 'handoff-atomic-failure'
        BEGIN
          SELECT RAISE(ABORT, 'simulated envelope failure');
        END
      `;
      const atomicFailure = yield* Effect.result(
        store.createPrepared(
          makePrepared({
            handoffId: "handoff-atomic-failure",
            threadId: "thread-atomic-failure",
          }),
        ),
      );
      assert.equal(atomicFailure._tag, "Failure");
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_provider_handoffs
        WHERE handoff_id = 'handoff-atomic-failure'
      `;
      assert.deepEqual(rows, [{ count: 0 }]);
    }),
  );

  it.effect("uses state and envelope hash as a legal-transition CAS", () =>
    Effect.gen(function* () {
      const store = yield* ThreadProviderHandoffStore;
      const prepared = makePrepared({
        handoffId: "handoff-cas",
        threadId: "thread-cas",
      });
      yield* store.createPrepared(prepared);

      assertConflict(
        yield* Effect.result(
          store.transition({
            handoffId: prepared.record.handoffId,
            expectedState: "validating",
            expectedEnvelopeHash: prepared.envelope.envelopeHash,
            nextState: "prepared",
            updatedAt: "2026-09-16T12:00:01.000Z",
          }),
        ),
        "cas-mismatch",
      );
      assertConflict(
        yield* Effect.result(
          store.transition({
            handoffId: prepared.record.handoffId,
            expectedState: "prepared",
            expectedEnvelopeHash: "b".repeat(64),
            nextState: "target-starting",
            updatedAt: "2026-09-16T12:00:01.000Z",
          }),
        ),
        "cas-mismatch",
      );
      assertConflict(
        yield* Effect.result(
          store.transition({
            handoffId: prepared.record.handoffId,
            expectedState: "prepared",
            expectedEnvelopeHash: prepared.envelope.envelopeHash,
            nextState: "committing",
            updatedAt: "2026-09-16T12:00:01.000Z",
          }),
        ),
        "illegal-transition",
      );

      const starting = yield* store.transition({
        handoffId: prepared.record.handoffId,
        expectedState: "prepared",
        expectedEnvelopeHash: prepared.envelope.envelopeHash,
        nextState: "target-starting",
        updatedAt: "2026-09-16T12:00:01.000Z",
      });
      assert.equal(starting.record.state, "target-starting");
      assert.deepEqual(starting.envelope, prepared.envelope);
      assertConflict(
        yield* Effect.result(
          store.transition({
            handoffId: prepared.record.handoffId,
            expectedState: "prepared",
            expectedEnvelopeHash: prepared.envelope.envelopeHash,
            nextState: "target-starting",
            updatedAt: "2026-09-16T12:00:01.000Z",
          }),
        ),
        "cas-mismatch",
      );

      const failed = yield* store.transition({
        handoffId: prepared.record.handoffId,
        expectedState: "target-starting",
        expectedEnvelopeHash: prepared.envelope.envelopeHash,
        nextState: "failed",
        updatedAt: "2026-09-16T12:00:02.000Z",
        errorCode: "target-start-failed",
      });
      assert.deepInclude(failed.record, {
        state: "failed",
        errorCode: "target-start-failed",
      });
      assert.isFalse(
        (yield* store.listRecoverable()).some(
          (handoff) => handoff.record.handoffId === prepared.record.handoffId,
        ),
      );

      const replacement = makePrepared({
        handoffId: "handoff-after-terminal",
        threadId: "thread-cas",
      });
      assert.deepEqual(yield* store.createPrepared(replacement), replacement);
    }),
  );

  it.effect("can quarantine a prepared handoff whose source binding changed during restart", () =>
    Effect.gen(function* () {
      const store = yield* ThreadProviderHandoffStore;
      const prepared = makePrepared({ handoffId: "handoff-unknown", threadId: "thread-unknown" });
      yield* store.createPrepared(prepared);
      const unknown = yield* store.transition({
        handoffId: prepared.record.handoffId,
        expectedState: "prepared",
        expectedEnvelopeHash: prepared.envelope.envelopeHash,
        nextState: "unknown",
        updatedAt: "2026-09-16T12:00:01.000Z",
        errorCode: "startup-recovery-unresolved",
      });
      assert.equal(unknown.record.state, "unknown");
    }),
  );
});

it.effect("restores prepared handoffs from disk without advancing recovery state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handoff-store-" });
    const dbPath = path.join(fixtureRoot, "restart.sqlite");
    const prepared = makePrepared({
      handoffId: "handoff-restart",
      threadId: "thread-restart",
    });

    yield* Effect.gen(function* () {
      const store = yield* ThreadProviderHandoffStore;
      yield* store.createPrepared(prepared);
      yield* store.saveSourceBinding(prepared.record.handoffId, {
        threadId: prepared.record.threadId,
        provider: prepared.record.source.driver,
        providerInstanceId: prepared.record.source.providerInstanceId,
        resumeCursor: { privateCursor: "resume-me" },
      });
    }).pipe(
      Effect.provide(makeStoreLayer(NodeSqliteClient.layer({ filename: dbPath }))),
      Effect.scoped,
    );

    yield* Effect.gen(function* () {
      const store = yield* ThreadProviderHandoffStore;
      const firstRead = yield* store.listRecoverable();
      const secondRead = yield* store.listRecoverable();
      assert.deepEqual(firstRead, [prepared]);
      assert.deepEqual(secondRead, firstRead);
      assert.equal(firstRead[0]?.record.state, "prepared");
      assert.deepEqual(
        Option.getOrThrow(yield* store.getSourceBinding(prepared.record.handoffId)),
        {
          threadId: prepared.record.threadId,
          provider: prepared.record.source.driver,
          providerInstanceId: prepared.record.source.providerInstanceId,
          resumeCursor: { privateCursor: "resume-me" },
        },
      );
    }).pipe(
      Effect.provide(makeStoreLayer(NodeSqliteClient.layer({ filename: dbPath }))),
      Effect.scoped,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
