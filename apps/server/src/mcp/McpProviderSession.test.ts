import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  clearAllMcpProviderSessions,
  clearMcpProviderSession,
  readMcpProviderSession,
  setMcpProviderSession,
  withAgentDeviceEnvironment,
} from "./McpProviderSession.ts";

describe("provider-scoped MCP sessions", () => {
  const threadId = ThreadId.make("thread-handoff");
  const sourceInstanceId = ProviderInstanceId.make("codex-source");
  const targetInstanceId = ProviderInstanceId.make("claude-target");
  const config = (providerInstanceId: ProviderInstanceId, providerSessionId: string) => ({
    environmentId: EnvironmentId.make("environment-handoff"),
    threadId,
    providerSessionId,
    providerInstanceId,
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer fixture",
    capabilities: new Set<string>(),
  });

  it("keeps the source credential when a target starts and removes only the aborted target", () => {
    clearAllMcpProviderSessions();
    const source = config(sourceInstanceId, "source-session");
    const target = config(targetInstanceId, "target-session");
    setMcpProviderSession(source);
    setMcpProviderSession(target);
    expect(readMcpProviderSession(threadId, sourceInstanceId)).toEqual(source);
    expect(readMcpProviderSession(threadId, targetInstanceId)).toEqual(target);
    expect(readMcpProviderSession(threadId)).toBeUndefined();
    clearMcpProviderSession(threadId, targetInstanceId);
    expect(readMcpProviderSession(threadId, sourceInstanceId)).toEqual(source);
    clearAllMcpProviderSessions();
  });
});

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});
