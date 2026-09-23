import type {
  EnvironmentBundleCredentialResolutions,
  PortableCredentialReference,
} from "@t3tools/contracts";

type EnvironmentLookup = Readonly<Record<string, string | undefined>>;

/**
 * Resolve only the references explicitly supplied by the operator. The result
 * intentionally contains no credential values and never enumerates the host
 * environment. Native secret stores stay unsupported until their adapters can
 * resolve stable local identifiers without exposing secret material.
 */
export function resolveEnvironmentBundleCredentialReferences(
  references: ReadonlyArray<PortableCredentialReference>,
  environment: EnvironmentLookup = process.env,
): EnvironmentBundleCredentialResolutions {
  const unique = new Map(
    references.map((reference) => [`${reference.kind}:${reference.id}`, reference]),
  );
  return [...unique.values()]
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
    .map((credentialRef) => ({
      credentialRef,
      status:
        credentialRef.kind !== "environment-variable"
          ? "unsupported"
          : (environment[credentialRef.id]?.trim().length ?? 0) > 0
            ? "resolved"
            : "missing",
    }));
}
