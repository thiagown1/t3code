/**
 * OpenRouterApiKey - the environment's OpenRouter key for FirstMate turn review.
 *
 * The key lives in the server secret store so it can be set from any client,
 * including remote ones, without editing the host's environment. The
 * `OPENROUTER_API_KEY` variable is a fallback for hosts configured that way.
 * The key itself never leaves the server: clients only learn whether one is
 * configured.
 *
 * @module OpenRouterApiKey
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SECRET_NAME = "openrouter-api-key";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class OpenRouterApiKey extends Context.Service<
  OpenRouterApiKey,
  {
    /** The stored key, else the environment variable. Read failures count as unset. */
    readonly get: Effect.Effect<Option.Option<string>>;
    /** Store a key, or remove the stored one with `null`. */
    readonly set: (key: string | null) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly status: Effect.Effect<{ readonly configured: boolean }>;
  }
>()("t3/firstMate/OpenRouterApiKey") {}

export const make = (environment: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;

    const get: OpenRouterApiKey["Service"]["get"] = secretStore.get(SECRET_NAME).pipe(
      Effect.map((stored) =>
        stored.pipe(
          Option.map((bytes) => textDecoder.decode(bytes).trim()),
          Option.filter((key) => key.length > 0),
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning("OpenRouter API key could not be read", { error: error.message }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
      Effect.map((stored) =>
        Option.orElse(stored, () =>
          Option.fromNullishOr(environment.OPENROUTER_API_KEY?.trim() || undefined),
        ),
      ),
    );

    const set: OpenRouterApiKey["Service"]["set"] = (key) => {
      const trimmed = key?.trim() ?? "";
      return trimmed.length === 0
        ? secretStore.remove(SECRET_NAME)
        : secretStore.set(SECRET_NAME, textEncoder.encode(trimmed));
    };

    return OpenRouterApiKey.of({
      get,
      set,
      status: get.pipe(Effect.map((key) => ({ configured: Option.isSome(key) }))),
    });
  });

export const layer = Layer.effect(OpenRouterApiKey, make());
