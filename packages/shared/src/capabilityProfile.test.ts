import type { PortableCapabilityProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  diffCapabilityProfiles,
  parseCapabilityProfileJson,
  resolveEffectiveCapability,
  serializeCapabilityProfile,
} from "./capabilityProfile.ts";

const profile = (
  capabilities: PortableCapabilityProfile["capabilities"],
): PortableCapabilityProfile => ({
  schemaVersion: 1,
  profileId: "turbo-station",
  name: "Turbo Station",
  capabilities,
});

describe("portable capability profiles", () => {
  it("exports declarations deterministically without credential material", () => {
    const value = profile([
      {
        capabilityId: "ssh.connect",
        state: "disabled",
        scope: { environment: "production" },
      },
      {
        capabilityId: "firebase.read",
        state: "enabled",
        credentialRef: { kind: "environment-variable", id: "FIREBASE_SERVICE_ACCOUNT" },
      },
    ]);

    const exported = serializeCapabilityProfile(value);

    expect(exported).toBe(serializeCapabilityProfile(value));
    expect(exported.indexOf("firebase.read")).toBeLessThan(exported.indexOf("ssh.connect"));
    expect(exported).toContain('"credentialRef"');
    expect(exported).not.toMatch(/privateKey|accessToken|password|cookie/i);
    expect(parseCapabilityProfileJson(exported)).toEqual({
      ...value,
      capabilities: [value.capabilities[1]!, value.capabilities[0]!],
    });

    const withUnknownSecretField = JSON.parse(exported) as Record<string, unknown>;
    (withUnknownSecretField.capabilities as Array<Record<string, unknown>>)[0]!.accessToken =
      "must-not-survive-import";
    expect(
      serializeCapabilityProfile(
        parseCapabilityProfileJson(JSON.stringify(withUnknownSecretField)),
      ),
    ).not.toContain("must-not-survive-import");
  });

  it("denies undeclared, unavailable, unauthorized, and ambiguous capabilities", () => {
    const value = profile([
      { capabilityId: "logs.query", state: "enabled" },
      {
        capabilityId: "logs.query",
        state: "enabled",
        scope: { environment: "production" },
      },
      {
        capabilityId: "logs.query",
        state: "disabled",
        scope: { environment: "production" },
      },
    ]);

    expect(
      resolveEffectiveCapability({
        profile: value,
        capabilityId: "firebase.read",
        scope: {},
        available: true,
        authorized: true,
      }),
    ).toMatchObject({ allowed: false, reason: "undeclared" });
    expect(
      resolveEffectiveCapability({
        profile: profile([{ capabilityId: "logs.query", state: "enabled" }]),
        capabilityId: "logs.query",
        scope: {},
        available: false,
        authorized: true,
      }),
    ).toMatchObject({ allowed: false, reason: "unavailable" });
    expect(
      resolveEffectiveCapability({
        profile: profile([{ capabilityId: "logs.query", state: "enabled" }]),
        capabilityId: "logs.query",
        scope: {},
        available: true,
        authorized: false,
      }),
    ).toMatchObject({ allowed: false, reason: "not-authorized" });
    expect(
      resolveEffectiveCapability({
        profile: value,
        capabilityId: "logs.query",
        scope: { environment: "production" },
        available: true,
        authorized: true,
      }),
    ).toMatchObject({ allowed: false, reason: "ambiguous-policy" });
  });

  it("allows only an enabled, available, and authorized exact policy", () => {
    expect(
      resolveEffectiveCapability({
        profile: profile([
          { capabilityId: "github.write", state: "disabled" },
          {
            capabilityId: "github.write",
            state: "enabled",
            scope: { project: "turbo-station" },
          },
        ]),
        capabilityId: "github.write",
        scope: { project: "turbo-station" },
        available: true,
        authorized: true,
      }),
    ).toMatchObject({ allowed: true, reason: "allowed" });
  });

  it("builds a dry-run diff without mutating either profile", () => {
    const current = profile([{ capabilityId: "firebase.read", state: "enabled" }]);
    const incoming = profile([
      { capabilityId: "firebase.read", state: "disabled" },
      { capabilityId: "ssh.connect", state: "enabled" },
    ]);

    expect(diffCapabilityProfiles(current, incoming)).toEqual({
      added: [incoming.capabilities[1]],
      removed: [],
      changed: [{ before: current.capabilities[0], after: incoming.capabilities[0] }],
    });
    expect(current.capabilities[0]?.state).toBe("enabled");
  });
});
