import { describe, expect, it } from "@effect/vitest";

import { resolveEnvironmentBundleCredentialReferences } from "./EnvironmentBundleCredentials.ts";

describe("EnvironmentBundleCredentials", () => {
  it("resolves requested environment-variable names without returning their values", () => {
    const resolutions = resolveEnvironmentBundleCredentialReferences(
      [
        { kind: "environment-variable", id: "FIREBASE_TOKEN" },
        { kind: "environment-variable", id: "EMPTY_TOKEN" },
        { kind: "environment-variable", id: "MISSING_TOKEN" },
        { kind: "keychain", id: "github-work" },
        { kind: "environment-variable", id: "FIREBASE_TOKEN" },
      ],
      {
        FIREBASE_TOKEN: "do-not-return",
        EMPTY_TOKEN: "   ",
      },
    );

    expect(resolutions).toEqual([
      {
        credentialRef: { kind: "environment-variable", id: "EMPTY_TOKEN" },
        status: "missing",
      },
      {
        credentialRef: { kind: "environment-variable", id: "FIREBASE_TOKEN" },
        status: "resolved",
      },
      {
        credentialRef: { kind: "environment-variable", id: "MISSING_TOKEN" },
        status: "missing",
      },
      {
        credentialRef: { kind: "keychain", id: "github-work" },
        status: "unsupported",
      },
    ]);
    expect(JSON.stringify(resolutions)).not.toContain("do-not-return");
  });
});
