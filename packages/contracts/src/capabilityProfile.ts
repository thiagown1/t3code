import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PortableCapabilityState = Schema.Literals(["enabled", "disabled", "unavailable"]);
export type PortableCapabilityState = typeof PortableCapabilityState.Type;

export const PortableCredentialReferenceKind = Schema.Literals([
  "keychain",
  "credential-manager",
  "environment-variable",
  "managed",
]);
export type PortableCredentialReferenceKind = typeof PortableCredentialReferenceKind.Type;

export const PortableCredentialReference = Schema.Struct({
  kind: PortableCredentialReferenceKind,
  id: TrimmedNonEmptyString,
});
export type PortableCredentialReference = typeof PortableCredentialReference.Type;

export const PortableCapabilityScope = Schema.Struct({
  environment: Schema.optionalKey(TrimmedNonEmptyString),
  project: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  integration: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PortableCapabilityScope = typeof PortableCapabilityScope.Type;

export const PortableCapabilityDeclaration = Schema.Struct({
  capabilityId: TrimmedNonEmptyString,
  state: PortableCapabilityState,
  scope: Schema.optionalKey(PortableCapabilityScope),
  credentialRef: Schema.optionalKey(PortableCredentialReference),
});
export type PortableCapabilityDeclaration = typeof PortableCapabilityDeclaration.Type;

export const PortableCapabilityProfile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  profileId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  capabilities: Schema.Array(PortableCapabilityDeclaration),
});
export type PortableCapabilityProfile = typeof PortableCapabilityProfile.Type;
