import * as NodeUtil from "node:util";

import {
  ThreadProviderHandoffEnvelope,
  ThreadProviderHandoffRecord,
  ThreadProviderHandoffState,
  type ThreadId,
} from "@t3tools/contracts";
import { serializeThreadProviderHandoff } from "@t3tools/shared/threadProviderHandoff";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";

export const ThreadProviderHandoffStored = Schema.Struct({
  record: ThreadProviderHandoffRecord,
  envelope: ThreadProviderHandoffEnvelope,
});
export type ThreadProviderHandoffStored = typeof ThreadProviderHandoffStored.Type;

export const ThreadProviderHandoffStoreConflictReason = Schema.Literals([
  "active-thread-handoff",
  "cas-mismatch",
  "illegal-transition",
  "invalid-payload",
  "payload-mismatch",
]);
export type ThreadProviderHandoffStoreConflictReason =
  typeof ThreadProviderHandoffStoreConflictReason.Type;

export class ThreadProviderHandoffStoreConflictError extends Schema.TaggedError<ThreadProviderHandoffStoreConflictError>()(
  "ThreadProviderHandoffStoreConflictError",
  {
    handoffId: Schema.String,
    reason: ThreadProviderHandoffStoreConflictReason,
  },
) {}

export class ThreadProviderHandoffStoreNotFoundError extends Schema.TaggedError<ThreadProviderHandoffStoreNotFoundError>()(
  "ThreadProviderHandoffStoreNotFoundError",
  { handoffId: Schema.String },
) {}

export type ThreadProviderHandoffStoreError =
  | ThreadProviderHandoffStoreConflictError
  | ThreadProviderHandoffStoreNotFoundError
  | PersistenceDecodeError
  | PersistenceSqlError;

const ContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export interface TransitionThreadProviderHandoffInput {
  readonly handoffId: string;
  readonly expectedState: ThreadProviderHandoffRecord["state"];
  readonly expectedEnvelopeHash: string;
  readonly nextState: ThreadProviderHandoffRecord["state"];
  readonly updatedAt: string;
  readonly errorCode?: string;
}

const TransitionThreadProviderHandoffInputSchema = Schema.Struct({
  handoffId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  expectedState: ThreadProviderHandoffState,
  expectedEnvelopeHash: ContentHash,
  nextState: ThreadProviderHandoffState,
  updatedAt: Schema.DateTimeUtcFromString,
  errorCode: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
});

export class ThreadProviderHandoffStore extends Context.Service<
  ThreadProviderHandoffStore,
  {
    readonly createPrepared: (
      handoff: ThreadProviderHandoffStored,
    ) => Effect.Effect<ThreadProviderHandoffStored, ThreadProviderHandoffStoreError>;
    readonly getByHandoffId: (
      handoffId: string,
    ) => Effect.Effect<Option.Option<ThreadProviderHandoffStored>, ThreadProviderHandoffStoreError>;
    readonly transition: (
      input: TransitionThreadProviderHandoffInput,
    ) => Effect.Effect<ThreadProviderHandoffStored, ThreadProviderHandoffStoreError>;
    /** Read-only recovery inventory. This method never claims or advances a handoff. */
    readonly listRecoverable: () => Effect.Effect<
      ReadonlyArray<ThreadProviderHandoffStored>,
      ThreadProviderHandoffStoreError
    >;
    readonly saveSourceBinding: (
      handoffId: string,
      binding: ProviderRuntimeBinding,
    ) => Effect.Effect<void, ThreadProviderHandoffStoreError>;
    readonly getSourceBinding: (
      handoffId: string,
    ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ThreadProviderHandoffStoreError>;
  }
>()("t3/persistence/ThreadProviderHandoffStore") {}

const StoredDbRow = Schema.Struct({
  record: Schema.fromJsonString(ThreadProviderHandoffRecord),
  envelope: Schema.fromJsonString(ThreadProviderHandoffEnvelope),
});

const InsertRecordRow = Schema.Struct({
  handoffId: Schema.String,
  threadId: Schema.String,
  state: ThreadProviderHandoffState,
  contextHash: Schema.String,
  envelopeHash: Schema.String,
  record: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const InsertEnvelopeRow = Schema.Struct({
  handoffId: Schema.String,
  envelopeHash: Schema.String,
  envelope: Schema.String,
  createdAt: Schema.String,
});

const UpdateRecordRow = Schema.Struct({
  handoffId: Schema.String,
  expectedState: ThreadProviderHandoffState,
  expectedEnvelopeHash: Schema.String,
  nextState: ThreadProviderHandoffState,
  record: Schema.String,
  updatedAt: Schema.String,
});

const HandoffIdRow = Schema.Struct({ handoffId: Schema.String });
const GetByHandoffIdRequest = Schema.Struct({ handoffId: Schema.String });
const GetActiveByThreadIdRequest = Schema.Struct({ threadId: Schema.String });

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(ThreadProviderHandoffRecord));
const encodeEnvelope = Schema.encodeSync(Schema.fromJsonString(ThreadProviderHandoffEnvelope));
const decodeStored = Schema.decodeUnknownEffect(ThreadProviderHandoffStored);
const decodeTransitionInput = Schema.decodeUnknownEffect(
  TransitionThreadProviderHandoffInputSchema,
);
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isStoreConflictError = Schema.is(ThreadProviderHandoffStoreConflictError);
const isStoreNotFoundError = Schema.is(ThreadProviderHandoffStoreNotFoundError);
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);
const isPersistenceSqlError = Schema.is(PersistenceSqlError);

const terminalStates = new Set<ThreadProviderHandoffRecord["state"]>([
  "committed",
  "failed",
  "cancelled",
]);

const legalTransitions: Readonly<
  Record<ThreadProviderHandoffRecord["state"], ReadonlySet<ThreadProviderHandoffRecord["state"]>>
> = {
  requested: new Set(["validating", "failed", "cancelled"]),
  validating: new Set(["compacting", "prepared", "failed", "cancelled"]),
  compacting: new Set(["prepared", "failed", "cancelled"]),
  prepared: new Set(["target-starting", "failed", "cancelled", "unknown"]),
  "target-starting": new Set(["target-ready", "failed", "unknown"]),
  "target-ready": new Set(["committing", "failed", "unknown"]),
  committing: new Set(["committed", "failed", "unknown"]),
  unknown: new Set(["failed", "cancelled"]),
  committed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

function immutableRecordMatchesEnvelope(handoff: ThreadProviderHandoffStored): boolean {
  const { record, envelope } = handoff;
  return (
    record.schemaVersion === envelope.schemaVersion &&
    record.handoffId === envelope.handoffId &&
    record.threadId === envelope.threadId &&
    NodeUtil.isDeepStrictEqual(record.source, envelope.source) &&
    NodeUtil.isDeepStrictEqual(record.target, envelope.target) &&
    record.reason === envelope.reason &&
    record.sequence === envelope.sequence &&
    record.sourceTurnId === envelope.sourceTurnId &&
    record.contextHash === envelope.contextHash &&
    record.envelopeHash === envelope.envelopeHash &&
    NodeUtil.isDeepStrictEqual(record.omissions, envelope.omissions) &&
    record.createdAt === envelope.createdAt
  );
}

function immutableHandoffsEqual(
  left: ThreadProviderHandoffStored,
  right: ThreadProviderHandoffStored,
): boolean {
  return (
    immutableRecordMatchesEnvelope(left) &&
    immutableRecordMatchesEnvelope(right) &&
    NodeUtil.isDeepStrictEqual(left.envelope, right.envelope) &&
    left.record.handoffId === right.record.handoffId &&
    left.record.threadId === right.record.threadId &&
    left.record.createdAt === right.record.createdAt
  );
}

function conflict(
  handoffId: string,
  reason: ThreadProviderHandoffStoreConflictReason,
): ThreadProviderHandoffStoreConflictError {
  return new ThreadProviderHandoffStoreConflictError({ handoffId, reason });
}

function mapStoreError(operation: string, handoffId?: string, threadId?: ThreadId) {
  return (cause: unknown): ThreadProviderHandoffStoreError => {
    if (
      isStoreConflictError(cause) ||
      isStoreNotFoundError(cause) ||
      isPersistenceDecodeError(cause) ||
      isPersistenceSqlError(cause)
    ) {
      return cause;
    }
    if (Schema.isSchemaError(cause)) {
      return PersistenceDecodeError.fromSchemaError(
        `${operation}:decode`,
        cause,
        threadId === undefined ? undefined : { threadId },
      );
    }
    return new PersistenceSqlError({
      operation,
      ...(threadId === undefined ? {} : { correlation: { threadId } }),
      cause,
      ...(handoffId === undefined ? {} : { detail: `handoffId=${handoffId}` }),
    });
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByHandoffId = SqlSchema.findOneOption({
    Request: GetByHandoffIdRequest,
    Result: StoredDbRow,
    execute: ({ handoffId }) => sql`
      SELECT
        handoff.record_json AS record,
        envelope.envelope_json AS envelope
      FROM thread_provider_handoffs AS handoff
      INNER JOIN thread_provider_handoff_envelopes AS envelope
        ON envelope.handoff_id = handoff.handoff_id
      WHERE handoff.handoff_id = ${handoffId}
    `,
  });

  const findActiveByThreadId = SqlSchema.findOneOption({
    Request: GetActiveByThreadIdRequest,
    Result: HandoffIdRow,
    execute: ({ threadId }) => sql`
      SELECT handoff_id AS "handoffId"
      FROM thread_provider_handoffs
      WHERE thread_id = ${threadId}
        AND state NOT IN ('committed', 'failed', 'cancelled')
      LIMIT 1
    `,
  });

  const insertRecord = SqlSchema.void({
    Request: InsertRecordRow,
    execute: (row) => sql`
      INSERT INTO thread_provider_handoffs (
        handoff_id,
        thread_id,
        state,
        context_hash,
        envelope_hash,
        record_json,
        created_at,
        updated_at
      ) VALUES (
        ${row.handoffId},
        ${row.threadId},
        ${row.state},
        ${row.contextHash},
        ${row.envelopeHash},
        ${row.record},
        ${row.createdAt},
        ${row.updatedAt}
      )
    `,
  });

  const insertEnvelope = SqlSchema.void({
    Request: InsertEnvelopeRow,
    execute: (row) => sql`
      INSERT INTO thread_provider_handoff_envelopes (
        handoff_id,
        envelope_hash,
        envelope_json,
        created_at
      ) VALUES (
        ${row.handoffId},
        ${row.envelopeHash},
        ${row.envelope},
        ${row.createdAt}
      )
    `,
  });

  const updateRecord = SqlSchema.findOneOption({
    Request: UpdateRecordRow,
    Result: HandoffIdRow,
    execute: (row) => sql`
      UPDATE thread_provider_handoffs
      SET
        state = ${row.nextState},
        record_json = ${row.record},
        updated_at = ${row.updatedAt}
      WHERE handoff_id = ${row.handoffId}
        AND state = ${row.expectedState}
        AND envelope_hash = ${row.expectedEnvelopeHash}
      RETURNING handoff_id AS "handoffId"
    `,
  });

  const listRecoverableRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: StoredDbRow,
    execute: () => sql`
      SELECT
        handoff.record_json AS record,
        envelope.envelope_json AS envelope
      FROM thread_provider_handoffs AS handoff
      INNER JOIN thread_provider_handoff_envelopes AS envelope
        ON envelope.handoff_id = handoff.handoff_id
      WHERE handoff.state NOT IN ('committed', 'failed', 'cancelled')
      ORDER BY handoff.updated_at ASC, handoff.handoff_id ASC
    `,
  });

  const getByHandoffId: ThreadProviderHandoffStore["Service"]["getByHandoffId"] = (handoffId) =>
    findByHandoffId({ handoffId }).pipe(
      Effect.mapError(mapStoreError("ThreadProviderHandoffStore.getByHandoffId", handoffId)),
    );

  const createPrepared: ThreadProviderHandoffStore["Service"]["createPrepared"] = (input) =>
    decodeStored(input).pipe(
      Effect.mapError(() => conflict(input.record.handoffId, "invalid-payload")),
      Effect.flatMap((handoff) =>
        Effect.try({
          try: () => {
            serializeThreadProviderHandoff(handoff.envelope);
            return handoff;
          },
          catch: () => conflict(handoff.record.handoffId, "invalid-payload"),
        }),
      ),
      Effect.flatMap((handoff) => {
        const { record, envelope } = handoff;
        if (
          record.state !== "prepared" ||
          terminalStates.has(record.state) ||
          record.errorCode !== undefined ||
          !immutableRecordMatchesEnvelope(handoff)
        ) {
          return Effect.fail(conflict(record.handoffId, "invalid-payload"));
        }

        return sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* findByHandoffId({ handoffId: record.handoffId });
            if (Option.isSome(existing)) {
              if (!immutableHandoffsEqual(existing.value, handoff)) {
                return yield* conflict(record.handoffId, "payload-mismatch");
              }
              return existing.value;
            }

            const active = yield* findActiveByThreadId({ threadId: record.threadId });
            if (Option.isSome(active)) {
              return yield* conflict(record.handoffId, "active-thread-handoff");
            }

            yield* insertRecord({
              handoffId: record.handoffId,
              threadId: record.threadId,
              state: record.state,
              contextHash: envelope.contextHash,
              envelopeHash: envelope.envelopeHash,
              record: encodeRecord(record),
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            });
            yield* insertEnvelope({
              handoffId: envelope.handoffId,
              envelopeHash: envelope.envelopeHash,
              envelope: encodeEnvelope(envelope),
              createdAt: envelope.createdAt,
            });
            return handoff;
          }),
        );
      }),
      Effect.mapError(
        mapStoreError(
          "ThreadProviderHandoffStore.createPrepared",
          input.record.handoffId,
          input.record.threadId,
        ),
      ),
    );

  const transition: ThreadProviderHandoffStore["Service"]["transition"] = (input) =>
    decodeTransitionInput(input).pipe(
      Effect.mapError(() => conflict(String(input.handoffId), "invalid-payload")),
      Effect.flatMap((validated) => {
        const updatedAt = DateTime.formatIso(validated.updatedAt);
        return sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* findByHandoffId({ handoffId: validated.handoffId });
            if (Option.isNone(existing)) {
              return yield* new ThreadProviderHandoffStoreNotFoundError({
                handoffId: validated.handoffId,
              });
            }
            const handoff = existing.value;
            if (
              handoff.record.state !== validated.expectedState ||
              handoff.record.envelopeHash !== validated.expectedEnvelopeHash
            ) {
              return yield* conflict(validated.handoffId, "cas-mismatch");
            }
            if (!legalTransitions[validated.expectedState].has(validated.nextState)) {
              return yield* conflict(validated.handoffId, "illegal-transition");
            }

            const record: ThreadProviderHandoffRecord = {
              ...handoff.record,
              state: validated.nextState,
              updatedAt,
              ...(validated.errorCode === undefined ? {} : { errorCode: validated.errorCode }),
            };
            const updated = yield* updateRecord({
              handoffId: validated.handoffId,
              expectedState: validated.expectedState,
              expectedEnvelopeHash: validated.expectedEnvelopeHash,
              nextState: validated.nextState,
              record: encodeRecord(record),
              updatedAt,
            });
            if (Option.isNone(updated)) {
              return yield* conflict(validated.handoffId, "cas-mismatch");
            }
            return { record, envelope: handoff.envelope };
          }),
        );
      }),
      Effect.mapError(mapStoreError("ThreadProviderHandoffStore.transition", input.handoffId)),
    );

  const listRecoverable: ThreadProviderHandoffStore["Service"]["listRecoverable"] = () =>
    listRecoverableRows(undefined).pipe(
      Effect.mapError(mapStoreError("ThreadProviderHandoffStore.listRecoverable")),
    );

  const saveSourceBinding: ThreadProviderHandoffStore["Service"]["saveSourceBinding"] = (
    handoffId,
    binding,
  ) =>
    encodeUnknownJson(binding).pipe(
      Effect.flatMap(
        (bindingJson) => sql`
          INSERT INTO thread_provider_handoff_source_bindings (handoff_id, binding_json)
          VALUES (${handoffId}, ${bindingJson})
          ON CONFLICT(handoff_id) DO NOTHING
        `,
      ),
      Effect.asVoid,
      Effect.mapError(mapStoreError("ThreadProviderHandoffStore.saveSourceBinding", handoffId)),
    );

  const getSourceBinding: ThreadProviderHandoffStore["Service"]["getSourceBinding"] = (handoffId) =>
    sql<{ binding_json: string }>`
        SELECT binding_json FROM thread_provider_handoff_source_bindings
        WHERE handoff_id = ${handoffId}
      `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.succeed(Option.none())
          : decodeUnknownJson(rows[0]!.binding_json).pipe(
              Effect.map((value) => Option.some(value as ProviderRuntimeBinding)),
            ),
      ),
      Effect.mapError(mapStoreError("ThreadProviderHandoffStore.getSourceBinding", handoffId)),
    );

  return ThreadProviderHandoffStore.of({
    createPrepared,
    getByHandoffId,
    transition,
    listRecoverable,
    saveSourceBinding,
    getSourceBinding,
  });
});

export const layer = Layer.effect(ThreadProviderHandoffStore, make);
