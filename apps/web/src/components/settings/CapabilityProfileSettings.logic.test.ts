import type { PortableCapabilityProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  capabilityProfileDownloadName,
  describeCapabilityProfileDiff,
  emptyCapabilityProfileForImport,
} from "./CapabilityProfileSettings.logic";

const profile = (name: string, capabilities: PortableCapabilityProfile["capabilities"] = []) => ({
  schemaVersion: 1 as const,
  profileId: "office",
  name,
  capabilities,
});

describe("capability profile settings", () => {
  it("creates a deny-by-default import template without credential values", () => {
    expect(emptyCapabilityProfileForImport("My workstation")).toEqual({
      schemaVersion: 1,
      profileId: "my-workstation",
      name: "My workstation",
      capabilities: [],
    });
  });

  it("summarizes a dry-run diff before an import is applied", () => {
    const current = profile("Office", [
      { capabilityId: "firebase.logs.read", state: "disabled" },
      { capabilityId: "ssh.metrics.read", state: "enabled" },
    ]);
    const incoming = profile("Office secure", [
      { capabilityId: "firebase.logs.read", state: "enabled" },
      { capabilityId: "github.checks.read", state: "enabled" },
    ]);

    expect(describeCapabilityProfileDiff(current, incoming)).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      profileChanged: true,
    });
  });

  it("sanitizes the exported filename", () => {
    expect(capabilityProfileDownloadName(profile("Office / Windows"))).toBe(
      "t3-capabilities-office.json",
    );
  });
});
