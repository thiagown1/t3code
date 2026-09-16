import NodeCrypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  EnvironmentBundleApplyOperation,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

type ProviderEnableOperation = Extract<
  EnvironmentBundleApplyOperation,
  { readonly adapter: "provider-settings-enable" }
>;

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

function legacyProviderSettings(
  settings: ServerSettings,
  operation: ProviderEnableOperation,
): LegacyProviderSettings | null {
  if (
    operation.settingsTarget !== "legacy" ||
    operation.instanceId !== operation.driver ||
    Object.hasOwn(settings.providerInstances, operation.instanceId)
  ) {
    return null;
  }
  return (
    (settings.providers as Readonly<Record<string, LegacyProviderSettings | undefined>>)[
      operation.driver
    ] ?? null
  );
}

function providerInstanceSettings(
  settings: ServerSettings,
  operation: ProviderEnableOperation,
): ServerSettings["providerInstances"][keyof ServerSettings["providerInstances"]] | null {
  const instance = settings.providerInstances[ProviderInstanceId.make(operation.instanceId)];
  return operation.settingsTarget === "instance" && instance?.driver === operation.driver
    ? instance
    : null;
}

/**
 * Binds a reviewed provider enable to the secret-free part of its settings
 * target. Provider configuration and credentials stay local and are validated
 * by the post-write health check instead of being exposed in the apply plan
 * hash.
 */
export function providerEnableTargetStateHash(
  settings: ServerSettings,
  operations: ReadonlyArray<ProviderEnableOperation>,
): string {
  const targets = operations
    .map((operation) => {
      const instance = providerInstanceSettings(settings, operation);
      return {
        instanceId: operation.instanceId,
        driver: operation.driver,
        storage: operation.settingsTarget,
        enabled: instance?.enabled ?? legacyProviderSettings(settings, operation)?.enabled ?? null,
      };
    })
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  return NodeCrypto.createHash("sha256").update(JSON.stringify(targets)).digest("hex");
}

export function providerEnablePatch(
  operations: ReadonlyArray<ProviderEnableOperation>,
  enabled: boolean,
): ServerSettingsPatch {
  const legacyOperations = operations.filter((operation) => operation.settingsTarget === "legacy");
  const instanceOperations = operations.filter(
    (operation) => operation.settingsTarget === "instance",
  );
  return {
    ...(legacyOperations.length > 0
      ? {
          providers: Object.fromEntries(
            legacyOperations.map((operation) => [operation.driver, { enabled }]),
          ) as NonNullable<ServerSettingsPatch["providers"]>,
        }
      : {}),
    ...(instanceOperations.length > 0
      ? {
          providerInstanceEnablement: Object.fromEntries(
            instanceOperations.map((operation) => [operation.instanceId, enabled]),
          ) as NonNullable<ServerSettingsPatch["providerInstanceEnablement"]>,
        }
      : {}),
  };
}

/**
 * Rollback is allowed only while every provider entry is byte-for-byte equal
 * to the state returned by our write. This preserves concurrent edits instead
 * of reverting them accidentally.
 */
export function canRollbackProviderEnables(input: {
  readonly current: ServerSettings;
  readonly written: ServerSettings;
  readonly operations: ReadonlyArray<ProviderEnableOperation>;
}): boolean {
  return input.operations.every((operation) => {
    const currentInstance = providerInstanceSettings(input.current, operation);
    const writtenInstance = providerInstanceSettings(input.written, operation);
    if (currentInstance || writtenInstance) {
      return (
        currentInstance !== null &&
        writtenInstance !== null &&
        isDeepStrictEqual(currentInstance, writtenInstance)
      );
    }
    const current = legacyProviderSettings(input.current, operation);
    const written = legacyProviderSettings(input.written, operation);
    return current !== null && written !== null && isDeepStrictEqual(current, written);
  });
}
