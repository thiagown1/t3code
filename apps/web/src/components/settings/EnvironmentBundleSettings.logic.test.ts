import type { PortableCapabilityProfile, ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildEnvironmentBundleSettingsPatch,
  buildEnvironmentBundleInventory,
  collectEnvironmentBundleCredentialReferences,
  environmentBundleDownloadName,
  getEnvironmentBundleApplyReadiness,
  setEnvironmentBundleEntryEnabled,
  summarizeEnvironmentBundleCredentialResolutions,
  summarizeEnvironmentBundleDiff,
} from "./EnvironmentBundleSettings.logic";

const profile: PortableCapabilityProfile = {
  schemaVersion: 1,
  profileId: "turbo",
  name: "Turbo",
  capabilities: [],
};

describe("Environment Bundle settings", () => {
  it("builds providers and workspace skills without exporting absolute paths", () => {
    const bundle = buildEnvironmentBundleInventory({
      environmentId: "desk-28",
      environmentLabel: "Desk 28",
      cwd: "C:\\work\\turbo",
      capabilityProfile: profile,
      serverInventory: {
        mcpServers: [
          {
            serverId: "codex:codex:logs",
            origin: "codex:codex:effective-config",
            enabled: false,
            configurationRef: "codex:codex:mcp:logs",
            configurationHash: "b".repeat(64),
            credentialRefs: [],
            allowedTools: ["query"],
            blockedTools: ["delete"],
          },
        ],
        mcpCoverage: "partial",
        projectInstructions: [
          { logicalPath: "AGENTS.md", contentHash: "a".repeat(64), enabled: true },
        ],
        projectInstructionsCoverage: "partial",
      },
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          version: "1.2.3",
          skills: [],
          workspaceSnapshots: [
            {
              cwd: "C:\\work\\turbo",
              checkedAt: "2026-09-15T12:00:00.000Z",
              slashCommands: [],
              skills: [
                {
                  name: "station-audit",
                  path: "C:\\work\\turbo\\.agents\\skills\\station-audit\\SKILL.md",
                  scope: "repo",
                  enabled: true,
                },
                {
                  name: "github",
                  path: "C:\\Users\\T\\.codex\\plugins\\cache\\openai-curated\\github\\skills\\github\\SKILL.md",
                  scope: "user",
                  enabled: true,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(bundle.providers).toEqual([
      { instanceId: "codex", driver: "codex", enabled: true, version: "1.2.3" },
    ]);
    expect(bundle.skills).toEqual([
      {
        skillId: "codex:project:station-audit",
        name: "station-audit",
        origin: "project",
        enabled: true,
        logicalPath: ".agents/skills/station-audit/SKILL.md",
      },
      {
        skillId: "codex:plugin:github",
        name: "github",
        origin: "plugin",
        enabled: true,
        providedByPluginId: "openai-curated:github",
      },
    ]);
    expect(bundle.pluginsAndApps).toEqual([
      { integrationId: "openai-curated:github", kind: "app", enabled: true },
    ]);
    expect(bundle.projectInstructions).toEqual([
      { logicalPath: "AGENTS.md", contentHash: "a".repeat(64), enabled: true },
    ]);
    expect(bundle.mcpServers).toEqual([
      expect.objectContaining({ serverId: "codex:codex:logs", enabled: false }),
    ]);
    expect(JSON.stringify(bundle)).not.toContain("C:\\\\Users");
  });

  it("deduplicates a provider skill and keeps an enabled observation", () => {
    const bundle = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: null,
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          version: null,
          skills: [
            { name: "audit", path: "/one/audit/SKILL.md", enabled: false },
            { name: "audit", path: "/two/audit/SKILL.md", enabled: true },
          ],
        },
      ],
    });

    expect(bundle.skills).toHaveLength(1);
    expect(bundle.skills[0]?.enabled).toBe(true);
    expect(bundle.capabilityProfile.capabilities).toEqual([]);
  });

  it("summarizes every dry-run inventory", () => {
    const current = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: profile,
      providers: [],
    });
    const incoming = {
      ...current,
      skills: [{ skillId: "codex:local:a", name: "a", origin: "local" as const, enabled: true }],
      providers: [{ instanceId: "codex", driver: "codex", enabled: true }],
    };

    expect(summarizeEnvironmentBundleDiff(current, incoming)).toEqual({
      added: 2,
      changed: 0,
      removed: 0,
      metadataChanged: false,
      steps: [
        {
          component: "skill",
          id: "codex:local:a",
          operation: "add",
          requiresProviderReload: true,
          healthCheckRequired: false,
        },
        {
          component: "provider",
          id: "codex",
          operation: "add",
          requiresProviderReload: true,
          healthCheckRequired: true,
        },
      ],
    });
    expect(environmentBundleDownloadName(incoming)).toBe("t3-environment-desk.json");
  });

  it("prepares enablement changes without mutating the imported bundle", () => {
    const incoming = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: {
        ...profile,
        capabilities: [{ capabilityId: "firebase.logs", state: "enabled" }],
      },
      serverInventory: {
        mcpServers: [
          {
            serverId: "codex:logs",
            origin: "codex:effective-config",
            enabled: true,
            configurationRef: "codex:mcp:logs",
            credentialRefs: [],
            allowedTools: [],
            blockedTools: [],
          },
        ],
        mcpCoverage: "partial",
        projectInstructions: [],
        projectInstructionsCoverage: "partial",
      },
      providers: [],
    });

    const prepared = setEnvironmentBundleEntryEnabled(
      incoming,
      { component: "mcp-server", id: "codex:logs" },
      false,
    );
    const withCapabilityDisabled = setEnvironmentBundleEntryEnabled(
      prepared,
      { component: "capability", id: "firebase.logs|*|*|*|*" },
      false,
    );

    expect(incoming.mcpServers[0]?.enabled).toBe(true);
    expect(incoming.capabilityProfile.capabilities[0]?.state).toBe("enabled");
    expect(withCapabilityDisabled.mcpServers[0]?.enabled).toBe(false);
    expect(withCapabilityDisabled.capabilityProfile.capabilities[0]?.state).toBe("disabled");
    expect(summarizeEnvironmentBundleDiff(incoming, withCapabilityDisabled)).toMatchObject({
      added: 0,
      changed: 2,
      removed: 0,
    });
  });

  it("rejects an enablement target that is not in the imported bundle", () => {
    const incoming = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: profile,
      providers: [],
    });

    expect(() =>
      setEnvironmentBundleEntryEnabled(incoming, { component: "provider", id: "missing" }, false),
    ).toThrow("Environment Bundle provider not found: missing");
  });

  it("allows atomic apply only when the capability profile is the sole environment change", () => {
    const current = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: profile,
      providers: [],
    });
    const capabilityOnly = {
      ...current,
      capabilityProfile: {
        ...profile,
        capabilities: [{ capabilityId: "firebase.logs", state: "disabled" as const }],
      },
    };
    const withUnsupportedSkill = {
      ...capabilityOnly,
      skills: [{ skillId: "codex:local:a", name: "a", origin: "local" as const, enabled: true }],
    };

    expect(getEnvironmentBundleApplyReadiness(current, capabilityOnly)).toEqual({
      canApply: true,
      capabilityProfileChanged: true,
      blockers: [],
      providerInstancesToDisable: [],
    });
    expect(getEnvironmentBundleApplyReadiness(current, withUnsupportedSkill)).toEqual({
      canApply: false,
      capabilityProfileChanged: true,
      blockers: ["skill:a requires an application adapter"],
      providerInstancesToDisable: [],
    });
    expect(getEnvironmentBundleApplyReadiness(current, current)).toEqual({
      canApply: false,
      capabilityProfileChanged: false,
      blockers: ["The bundle does not contain any supported changes to apply"],
      providerInstancesToDisable: [],
    });
  });

  it("prepares a provider disable while preserving its local configuration", () => {
    const providerInstance = {
      driver: "codex",
      displayName: "Work Codex",
      enabled: true,
      config: { homePath: "C:/secret-local-path", apiKey: "never-export" },
    };
    const providerInstances = {
      codex_work: providerInstance,
    } as unknown as ServerSettings["providerInstances"];
    const current = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: profile,
      providers: [
        {
          instanceId: "codex_work",
          driver: "codex",
          enabled: true,
          version: "1.2.3",
          skills: [],
        },
      ],
    });
    const incoming = {
      ...current,
      providers: [{ ...current.providers[0]!, enabled: false }],
    };

    expect(getEnvironmentBundleApplyReadiness(current, incoming, { providerInstances })).toEqual({
      canApply: true,
      capabilityProfileChanged: false,
      blockers: [],
      providerInstancesToDisable: ["codex_work"],
    });
    expect(buildEnvironmentBundleSettingsPatch(current, incoming, { providerInstances })).toEqual({
      providerInstances: {
        codex_work: {
          ...providerInstance,
          enabled: false,
        },
      },
    });
    expect(providerInstance.enabled).toBe(true);
  });

  it("keeps provider enablement blocked until a health-checked adapter exists", () => {
    const providerInstances = {
      codex_work: { driver: "codex", enabled: false, config: { homePath: "C:/local" } },
    } as unknown as ServerSettings["providerInstances"];
    const current = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: profile,
      providers: [
        {
          instanceId: "codex_work",
          driver: "codex",
          enabled: false,
          version: null,
          skills: [],
        },
      ],
    });
    const incoming = {
      ...current,
      providers: [{ ...current.providers[0]!, enabled: true }],
    };

    expect(getEnvironmentBundleApplyReadiness(current, incoming, { providerInstances })).toEqual({
      canApply: false,
      capabilityProfileChanged: false,
      blockers: [
        "provider:codex_work cannot be enabled before a provider health-check adapter is available",
      ],
      providerInstancesToDisable: [],
    });
  });

  it("deduplicates credential references and summarizes local resolution", () => {
    const bundle = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: {
        ...profile,
        capabilities: [
          {
            capabilityId: "firebase.logs",
            state: "enabled",
            credentialRef: { kind: "environment-variable", id: "FIREBASE_TOKEN" },
          },
          {
            capabilityId: "github.read",
            state: "enabled",
            credentialRef: { kind: "keychain", id: "github-work" },
          },
        ],
      },
      serverInventory: {
        mcpServers: [
          {
            serverId: "codex:firebase",
            origin: "codex:effective-config",
            enabled: true,
            configurationRef: "codex:mcp:firebase",
            credentialRefs: [
              { kind: "environment-variable", id: "FIREBASE_TOKEN" },
              { kind: "environment-variable", id: "SECONDARY_TOKEN" },
            ],
            allowedTools: [],
            blockedTools: [],
          },
        ],
        mcpCoverage: "partial",
        projectInstructions: [],
        projectInstructionsCoverage: "partial",
      },
      providers: [],
    });

    expect(collectEnvironmentBundleCredentialReferences(bundle)).toEqual([
      { kind: "environment-variable", id: "FIREBASE_TOKEN" },
      { kind: "environment-variable", id: "SECONDARY_TOKEN" },
      { kind: "keychain", id: "github-work" },
    ]);
    expect(
      summarizeEnvironmentBundleCredentialResolutions([
        {
          credentialRef: { kind: "environment-variable", id: "FIREBASE_TOKEN" },
          status: "resolved",
        },
        {
          credentialRef: { kind: "environment-variable", id: "SECONDARY_TOKEN" },
          status: "missing",
        },
        {
          credentialRef: { kind: "keychain", id: "github-work" },
          status: "unsupported",
        },
      ]),
    ).toEqual({ resolved: 1, missing: 1, unsupported: 1 });
  });

  it("requires local credential resolution before enabling a capability", () => {
    const providerInstances = {} as ServerSettings["providerInstances"];
    const current = buildEnvironmentBundleInventory({
      environmentId: "desk",
      environmentLabel: "Desk",
      cwd: null,
      capabilityProfile: profile,
      providers: [],
    });
    const incoming = {
      ...current,
      capabilityProfile: {
        ...profile,
        capabilities: [
          {
            capabilityId: "firebase.logs",
            state: "enabled" as const,
            credentialRef: {
              kind: "environment-variable" as const,
              id: "FIREBASE_TOKEN",
            },
          },
        ],
      },
    };

    expect(getEnvironmentBundleApplyReadiness(current, incoming, { providerInstances })).toEqual({
      canApply: false,
      capabilityProfileChanged: true,
      blockers: ["credential:environment-variable:FIREBASE_TOKEN has not been checked"],
      providerInstancesToDisable: [],
    });
    expect(
      getEnvironmentBundleApplyReadiness(current, incoming, {
        providerInstances,
        credentialResolutions: [
          {
            credentialRef: { kind: "environment-variable", id: "FIREBASE_TOKEN" },
            status: "missing",
          },
        ],
      }),
    ).toMatchObject({
      canApply: false,
      blockers: ["credential:environment-variable:FIREBASE_TOKEN is missing"],
    });
    expect(
      getEnvironmentBundleApplyReadiness(current, incoming, {
        providerInstances,
        credentialResolutions: [
          {
            credentialRef: { kind: "environment-variable", id: "FIREBASE_TOKEN" },
            status: "resolved",
          },
        ],
      }),
    ).toMatchObject({ canApply: true, blockers: [] });
  });
});
