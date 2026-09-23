import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { make, OpenRouterApiKey } from "./OpenRouterApiKey.ts";

const KEY = "sk-or-v1-secret-value";

function withKeyService(environment: NodeJS.ProcessEnv = {}) {
  const secrets = new Map<string, Uint8Array>();
  const store = Layer.succeed(ServerSecretStore, {
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
  return Effect.service(OpenRouterApiKey).pipe(
    Effect.provide(Layer.effect(OpenRouterApiKey, make(environment)).pipe(Layer.provide(store))),
  );
}

describe("OpenRouterApiKey", () => {
  it.effect("reports only whether a key is configured", () =>
    Effect.gen(function* () {
      const service = yield* withKeyService();
      expect(yield* service.status).toEqual({ configured: false });

      yield* service.set(`  ${KEY}  `);
      const status = yield* service.status;
      expect(status).toEqual({ configured: true });
      expect(Object.keys(status)).toEqual(["configured"]);
      expect(yield* service.get).toEqual(Option.some(KEY));

      yield* service.set(null);
      expect(yield* service.status).toEqual({ configured: false });
    }),
  );

  it.effect("falls back to OPENROUTER_API_KEY", () =>
    Effect.gen(function* () {
      const service = yield* withKeyService({ OPENROUTER_API_KEY: KEY });
      expect(yield* service.status).toEqual({ configured: true });
      expect(yield* service.get).toEqual(Option.some(KEY));
    }),
  );

  it("is not part of server settings", () => {
    expect(Object.keys(DEFAULT_SERVER_SETTINGS).filter((key) => /openrouter/i.test(key))).toEqual(
      [],
    );
  });
});
