/**
 * JevDecisions - client for OpenRouter's Decisions API (alpha) running Jev.
 *
 * Jev answers typed questions about a piece of state: a `choice` among named
 * options with a calibrated confidence, or a `noul` probability for a yes/no
 * question. It is far cheaper than asking a chat model, which is why FirstMate
 * turn review uses it by default. Every failure (no key, HTTP, decode) is a
 * typed error; callers treat all of them as "no verdict" and take no action.
 *
 * @module JevDecisions
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { OpenRouterApiKey } from "./OpenRouterApiKey.ts";

/** The alpha endpoint. One constant so moving it is a one-line change. */
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

export type JevQuestion =
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria: { readonly true: string; readonly false: string };
    };

export interface JevDecideInput {
  readonly state: string | Readonly<Record<string, unknown>>;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

const JevChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: Schema.Finite,
  probabilities: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
});
const JevNoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Finite,
});
export const JevDecisionsResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Union([JevChoiceAnswer, JevNoulAnswer])),
});
export type JevAnswers = (typeof JevDecisionsResponse.Type)["answers"];

export class JevDecisionsError extends Schema.TaggedError<JevDecisionsError>()(
  "JevDecisionsError",
  {
    reason: Schema.Literals(["unavailable", "request-failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Jev decision failed (${this.reason}): ${this.detail}`;
  }
}

export class JevDecisions extends Context.Service<
  JevDecisions,
  {
    readonly decide: (input: JevDecideInput) => Effect.Effect<JevAnswers, JevDecisionsError>;
  }
>()("t3/firstMate/JevDecisions") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const apiKey = yield* OpenRouterApiKey;

  const decide: JevDecisions["Service"]["decide"] = Effect.fn("JevDecisions.decide")(
    function* (input) {
      const key = yield* apiKey.get;
      if (Option.isNone(key)) {
        return yield* new JevDecisionsError({
          reason: "unavailable",
          detail: "No OpenRouter API key is configured.",
        });
      }
      const response = yield* HttpClientRequest.post(JEV_DECISIONS_URL).pipe(
        HttpClientRequest.bearerToken(key.value),
        HttpClientRequest.bodyJson({
          model: JEV_MODEL,
          state: input.state,
          questions: input.questions,
        }),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(JevDecisionsResponse)),
        Effect.mapError(
          (cause) => new JevDecisionsError({ reason: "request-failed", detail: cause.message }),
        ),
      );
      return response.answers;
    },
  );

  return JevDecisions.of({ decide });
});

export const layer = Layer.effect(JevDecisions, make);
