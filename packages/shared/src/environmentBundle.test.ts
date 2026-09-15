import type { EnvironmentBundle } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildEnvironmentBundleApplicationPlan,
  diffEnvironmentBundles,
  parseEnvironmentBundleJson,
  resolveEnvironmentBundleHealth,
  serializeEnvironmentBundle,
} from "./environmentBundle.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function bundle(overrides: Partial<EnvironmentBundle> = {}): EnvironmentBundle {
  return {
    schemaVersion: 1,
    bundleId: "turbo-station-dev",
    name: "Turbo Station development",
    capabilityProfile: {
      schemaVersion: 1,
      profileId: "turbo-station",
      name: "Turbo Station",
      capabilities: [],
    },
    mcpServers: [],
    skills: [],
    pluginsAndApps: [],
    providers: [],
    projectInstructions: [],
    ...overrides,
  };
}

describe("environment bundles", () => {
  it("serializes a deterministic, secret-free inventory", () => {
    const value = bundle({
      mcpServers: [
        {
          serverId: "logs",
          origin: "project",
          enabled: true,
          configurationRef: "mcp.logs.production",
          configurationHash: HASH_A,
          credentialRefs: [{ kind: "environment-variable", id: "LOGS_API_TOKEN" }],
          allowedTools: ["query", "query"],
          blockedTools: ["delete", "write"],
        },
      ],
      skills: [
        { skillId: "z-skill", name: "Z", origin: "local", enabled: false },
        {
          skillId: "a-skill",
          name: "A",
          origin: "project",
          enabled: true,
          logicalPath: ".agents/skills/a/SKILL.md",
          contentHash: HASH_B,
        },
      ],
      providers: [{ instanceId: "codex", driver: "codex", enabled: true }],
      projectInstructions: [{ logicalPath: "AGENTS.md", contentHash: HASH_A, enabled: true }],
      initialSkillContextBudgetTokens: 8_000,
    });

    const exported = serializeEnvironmentBundle(value);
    expect(exported).toBe(serializeEnvironmentBundle(value));
    expect(exported.indexOf("a-skill")).toBeLessThan(exported.indexOf("z-skill"));
    expect(exported).toContain("LOGS_API_TOKEN");
    expect(exported).not.toMatch(/privateKey|accessToken|password|cookie/i);
    expect(parseEnvironmentBundleJson(exported).mcpServers[0]?.allowedTools).toEqual(["query"]);

    const unknownSecret = JSON.parse(exported) as Record<string, unknown>;
    (unknownSecret.mcpServers as Array<Record<string, unknown>>)[0]!.accessToken = "secret";
    expect(
      serializeEnvironmentBundle(parseEnvironmentBundleJson(JSON.stringify(unknownSecret))),
    ).not.toContain("secret");
  });

  it("rejects absolute and escaping paths", () => {
    expect(() =>
      serializeEnvironmentBundle(
        bundle({
          projectInstructions: [
            { logicalPath: "C:\\Users\\Thiago\\AGENTS.md", contentHash: HASH_A, enabled: true },
          ],
        }),
      ),
    ).toThrow(/logical and relative/);
    expect(() =>
      serializeEnvironmentBundle(
        bundle({
          skills: [
            {
              skillId: "escape",
              name: "Escape",
              origin: "project",
              enabled: true,
              logicalPath: "../SKILL.md",
            },
          ],
        }),
      ),
    ).toThrow(/logical and relative/);
  });

  it("rejects ambiguous duplicate inventory and MCP tool policy", () => {
    expect(() =>
      serializeEnvironmentBundle(
        bundle({
          providers: [
            { instanceId: "codex", driver: "codex", enabled: true },
            { instanceId: "codex", driver: "codex", enabled: false },
          ],
        }),
      ),
    ).toThrow(/duplicate provider instance ID/);
    expect(() =>
      serializeEnvironmentBundle(
        bundle({
          mcpServers: [
            {
              serverId: "logs",
              origin: "project",
              enabled: true,
              configurationRef: "mcp.logs",
              credentialRefs: [],
              allowedTools: ["query"],
              blockedTools: ["query"],
            },
          ],
        }),
      ),
    ).toThrow(/both allowed and blocked/);
  });

  it("builds a canonical dry-run diff for every inventory", () => {
    const current = bundle({
      skills: [{ skillId: "one", name: "One", origin: "local", enabled: true }],
      providers: [{ instanceId: "codex", driver: "codex", enabled: true }],
      initialSkillContextBudgetTokens: 4_000,
    });
    const incoming = bundle({
      skills: [
        { skillId: "one", name: "One", origin: "local", enabled: false },
        { skillId: "two", name: "Two", origin: "plugin", enabled: true },
      ],
      initialSkillContextBudgetTokens: 8_000,
    });

    const diff = diffEnvironmentBundles(current, incoming);
    expect(diff.skills).toEqual({
      added: [incoming.skills[1]],
      removed: [],
      changed: [{ before: current.skills[0], after: incoming.skills[0] }],
    });
    expect(diff.providers.removed).toEqual(current.providers);
    expect(diff.skillContextBudgetChanged).toBe(true);

    expect(buildEnvironmentBundleApplicationPlan(current, incoming)).toEqual([
      {
        component: "skill",
        id: "one",
        operation: "update",
        requiresProviderReload: true,
        healthCheckRequired: false,
      },
      {
        component: "skill",
        id: "two",
        operation: "add",
        requiresProviderReload: true,
        healthCheckRequired: false,
      },
      {
        component: "provider",
        id: "codex",
        operation: "remove",
        requiresProviderReload: true,
        healthCheckRequired: true,
      },
      {
        component: "skill-context-budget",
        id: "initial",
        operation: "update",
        requiresProviderReload: true,
        healthCheckRequired: false,
      },
    ]);
  });

  it("keeps health states explicit and never treats configured as ready", () => {
    const base = {
      enabled: true,
      configured: true,
      credentialsReady: true,
      available: true,
      healthCheckCompleted: true,
    };
    expect(resolveEnvironmentBundleHealth({ ...base, enabled: false })).toBe("disabled");
    expect(resolveEnvironmentBundleHealth({ ...base, configured: false })).toBe("unavailable");
    expect(resolveEnvironmentBundleHealth({ ...base, credentialsReady: false })).toBe(
      "missing-credential",
    );
    expect(resolveEnvironmentBundleHealth({ ...base, available: false })).toBe("unavailable");
    expect(resolveEnvironmentBundleHealth({ ...base, healthCheckCompleted: false })).toBe(
      "configured",
    );
    expect(resolveEnvironmentBundleHealth(base)).toBe("ready");
  });
});
