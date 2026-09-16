import * as ProcessRunner from "../processRunner.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PrSupervisionReceipt = Schema.Struct({
  schema: Schema.Literal("firstmate-pr-supervision/v1"),
  repository: Schema.optional(Schema.String),
  pullRequest: Schema.optional(Schema.Finite),
  owner: Schema.optional(Schema.String),
  lockSha: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  headSha: Schema.optional(Schema.String),
  baseSha: Schema.optional(Schema.String),
  gateCheckId: Schema.optional(Schema.Finite),
  gateSummary: Schema.optional(Schema.NullOr(Schema.String)),
  writerAuthorized: Schema.optional(Schema.Boolean),
  enrolled: Schema.optional(Schema.Boolean),
  released: Schema.optional(Schema.Boolean),
});
export type PrSupervisionReceipt = typeof PrSupervisionReceipt.Type;

export interface PrSupervisionAdapterInput {
  readonly cwd: string;
  readonly operation: "enroll" | "observe" | "release" | "inspect";
  readonly lockSha?: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly owner: string;
  readonly baseRef: string;
  readonly headRef: string;
}

export class PrSupervisionAdapterError extends Schema.TaggedError<PrSupervisionAdapterError>()(
  "PrSupervisionAdapterError",
  { detail: Schema.String },
) {}

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(PrSupervisionReceipt));

// The first integration is the reviewed Turbo Station adapter. Enrollment is
// explicit; an arbitrary command from a PR comment is never executed here.
export const runPrSupervisionAdapter = Effect.fn("runPrSupervisionAdapter")(function* (
  input: PrSupervisionAdapterInput,
) {
  const { cwd, ...request } = input;
  const runner = yield* ProcessRunner.make();
  const stdin = yield* encodeRequest(request).pipe(
    Effect.mapError(() => new PrSupervisionAdapterError({ detail: "Invalid supervision request" })),
  );
  const result = yield* runner
    .run({
      command: "node",
      args: [`${cwd}/next/scripts/ci/pr-supervisor.cjs`],
      cwd,
      stdin,
      timeout: "3 minutes",
      maxOutputBytes: 32_768,
      outputMode: "error",
    })
    .pipe(
      Effect.mapError(
        () => new PrSupervisionAdapterError({ detail: "PR supervision adapter could not run" }),
      ),
    );
  if (result.code !== 0 && result.code !== 2)
    return yield* new PrSupervisionAdapterError({ detail: "PR supervision adapter failed" });
  const receipt = yield* decodeReceipt(result.stdout).pipe(
    Effect.mapError(
      () => new PrSupervisionAdapterError({ detail: "Invalid PR supervision receipt" }),
    ),
  );
  if (
    receipt.state !== "unavailable" &&
    (receipt.repository !== input.repository ||
      receipt.pullRequest !== input.pullRequest ||
      receipt.owner !== input.owner)
  ) {
    return yield* new PrSupervisionAdapterError({
      detail: "PR supervision receipt belongs to another owner or PR",
    });
  }
  return receipt;
});
