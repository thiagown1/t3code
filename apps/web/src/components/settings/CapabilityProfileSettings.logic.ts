import type { PortableCapabilityProfile } from "@t3tools/contracts";
import { diffCapabilityProfiles } from "@t3tools/shared/capabilityProfile";

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "environment";
}

export function emptyCapabilityProfileForImport(label: string): PortableCapabilityProfile {
  return {
    schemaVersion: 1,
    profileId: slugify(label),
    name: label.trim() || "Environment",
    capabilities: [],
  };
}

export function capabilityProfileDownloadName(profile: PortableCapabilityProfile): string {
  return `t3-capabilities-${slugify(profile.profileId)}.json`;
}

export function describeCapabilityProfileDiff(
  current: PortableCapabilityProfile | null,
  incoming: PortableCapabilityProfile,
) {
  const baseline =
    current ??
    ({
      schemaVersion: 1,
      profileId: incoming.profileId,
      name: incoming.name,
      capabilities: [],
    } satisfies PortableCapabilityProfile);
  const diff = diffCapabilityProfiles(baseline, incoming);
  return {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    profileChanged:
      current === null ||
      current.profileId !== incoming.profileId ||
      current.name !== incoming.name,
  };
}
