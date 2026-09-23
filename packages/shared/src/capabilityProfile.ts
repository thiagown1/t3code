import {
  PortableCapabilityProfile,
  type PortableCapabilityDeclaration,
  type PortableCapabilityScope,
  type PortableCapabilityProfile as PortableCapabilityProfileType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const SCOPE_KEYS = ["environment", "project", "provider", "integration"] as const;
const decodePortableCapabilityProfile = Schema.decodeUnknownSync(PortableCapabilityProfile);

function normalizedScope(
  scope: PortableCapabilityScope | undefined,
): PortableCapabilityScope | undefined {
  if (!scope) return undefined;
  const normalized: Record<string, string> = {};
  for (const key of SCOPE_KEYS) {
    if (scope[key] !== undefined) normalized[key] = scope[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeDeclaration(
  declaration: PortableCapabilityDeclaration,
): PortableCapabilityDeclaration {
  const scope = normalizedScope(declaration.scope);
  return {
    capabilityId: declaration.capabilityId,
    state: declaration.state,
    ...(scope ? { scope } : {}),
    ...(declaration.credentialRef
      ? {
          credentialRef: {
            kind: declaration.credentialRef.kind,
            id: declaration.credentialRef.id,
          },
        }
      : {}),
  };
}

function declarationKey(declaration: PortableCapabilityDeclaration): string {
  const scope = normalizedScope(declaration.scope);
  return [declaration.capabilityId, ...SCOPE_KEYS.map((key) => scope?.[key] ?? "*")].join("|");
}

export function normalizeCapabilityProfile(
  profile: PortableCapabilityProfileType,
): PortableCapabilityProfileType {
  return {
    schemaVersion: 1,
    profileId: profile.profileId,
    name: profile.name,
    capabilities: [...profile.capabilities]
      .map(normalizeDeclaration)
      .sort((left, right) => declarationKey(left).localeCompare(declarationKey(right))),
  };
}

export function serializeCapabilityProfile(profile: PortableCapabilityProfileType): string {
  return `${JSON.stringify(normalizeCapabilityProfile(profile), null, 2)}\n`;
}

export function parseCapabilityProfileJson(json: string): PortableCapabilityProfileType {
  const decoded = decodePortableCapabilityProfile(JSON.parse(json));
  return normalizeCapabilityProfile(decoded);
}

export interface CapabilityProfileDiff {
  readonly added: ReadonlyArray<PortableCapabilityDeclaration>;
  readonly removed: ReadonlyArray<PortableCapabilityDeclaration>;
  readonly changed: ReadonlyArray<{
    readonly before: PortableCapabilityDeclaration;
    readonly after: PortableCapabilityDeclaration;
  }>;
}

export function diffCapabilityProfiles(
  current: PortableCapabilityProfileType,
  incoming: PortableCapabilityProfileType,
): CapabilityProfileDiff {
  const currentDeclarations = new Map(
    normalizeCapabilityProfile(current).capabilities.map((declaration) => [
      declarationKey(declaration),
      declaration,
    ]),
  );
  const incomingDeclarations = new Map(
    normalizeCapabilityProfile(incoming).capabilities.map((declaration) => [
      declarationKey(declaration),
      declaration,
    ]),
  );
  const added: PortableCapabilityDeclaration[] = [];
  const removed: PortableCapabilityDeclaration[] = [];
  const changed: Array<{
    before: PortableCapabilityDeclaration;
    after: PortableCapabilityDeclaration;
  }> = [];

  for (const [key, declaration] of incomingDeclarations) {
    const previous = currentDeclarations.get(key);
    if (!previous) {
      added.push(declaration);
    } else if (JSON.stringify(previous) !== JSON.stringify(declaration)) {
      changed.push({ before: previous, after: declaration });
    }
  }
  for (const [key, declaration] of currentDeclarations) {
    if (!incomingDeclarations.has(key)) removed.push(declaration);
  }
  return { added, removed, changed };
}

export type EffectiveCapabilityReason =
  | "allowed"
  | "undeclared"
  | "disabled"
  | "unavailable"
  | "not-authorized"
  | "ambiguous-policy";

export interface EffectiveCapabilityDecision {
  readonly allowed: boolean;
  readonly reason: EffectiveCapabilityReason;
  readonly declaration: PortableCapabilityDeclaration | null;
}

function scopeMatches(
  declaration: PortableCapabilityDeclaration,
  requested: PortableCapabilityScope,
): boolean {
  const scope = declaration.scope;
  return SCOPE_KEYS.every((key) => scope?.[key] === undefined || scope[key] === requested[key]);
}

function scopeSpecificity(declaration: PortableCapabilityDeclaration): number {
  return SCOPE_KEYS.reduce(
    (total, key) => total + (declaration.scope?.[key] === undefined ? 0 : 1),
    0,
  );
}

export function resolveEffectiveCapability(input: {
  readonly profile: PortableCapabilityProfileType;
  readonly capabilityId: string;
  readonly scope: PortableCapabilityScope;
  readonly available: boolean;
  readonly authorized: boolean;
}): EffectiveCapabilityDecision {
  const matches = input.profile.capabilities.filter(
    (declaration) =>
      declaration.capabilityId === input.capabilityId && scopeMatches(declaration, input.scope),
  );
  if (matches.length === 0) {
    return { allowed: false, reason: "undeclared", declaration: null };
  }
  const maxSpecificity = Math.max(...matches.map(scopeSpecificity));
  const mostSpecific = matches.filter(
    (declaration) => scopeSpecificity(declaration) === maxSpecificity,
  );
  if (mostSpecific.length !== 1) {
    return { allowed: false, reason: "ambiguous-policy", declaration: null };
  }
  const declaration = mostSpecific[0]!;
  if (declaration.state === "disabled") {
    return { allowed: false, reason: "disabled", declaration };
  }
  if (declaration.state === "unavailable" || !input.available) {
    return { allowed: false, reason: "unavailable", declaration };
  }
  if (!input.authorized) {
    return { allowed: false, reason: "not-authorized", declaration };
  }
  return { allowed: true, reason: "allowed", declaration };
}
