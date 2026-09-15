import type { PortableCapabilityProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildEnvironmentBundleInventory,
  environmentBundleDownloadName,
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
        mcpServers: [],
        mcpCoverage: "unavailable",
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
});
