import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { ServerConfig } from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";

// The identity file is outside SQLite; the path also fences full home copies
// on this machine. A copied database must never resume or release live owners.
export const supervisionEnvironmentKey = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const identity = yield* ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  return NodeCrypto.createHash("sha256").update(`${environmentId}\0${config.dbPath}`).digest("hex");
});
