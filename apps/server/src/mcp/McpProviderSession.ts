import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * Set when the thread was its project's FirstMate supervisor as the session
   * started. Adapters use it to add the coordinator runtime instructions; the
   * firstmate_* tools still gate on the live workspace at call time.
   */
  readonly firstMateCoordinator?: boolean;
}

/** Whether this provider session should receive the FirstMate coordinator instructions. */
export function isFirstMateCoordinatorSession(
  threadId: ThreadId,
  providerInstanceId?: ProviderInstanceId,
): boolean {
  return readMcpProviderSession(threadId, providerInstanceId)?.firstMateCoordinator === true;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, Map<ProviderInstanceId, McpProviderSessionConfig>>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  const sessions = sessionsByThread.get(config.threadId) ?? new Map();
  sessions.set(config.providerInstanceId, config);
  sessionsByThread.set(config.threadId, sessions);
}

export function readMcpProviderSession(
  threadId: ThreadId,
  providerInstanceId?: ProviderInstanceId,
): McpProviderSessionConfig | undefined {
  const sessions = sessionsByThread.get(threadId);
  if (providerInstanceId !== undefined) return sessions?.get(providerInstanceId);
  return sessions?.size === 1 ? sessions.values().next().value : undefined;
}

export function clearMcpProviderSession(
  threadId: ThreadId,
  providerInstanceId?: ProviderInstanceId,
): void {
  if (providerInstanceId === undefined) {
    sessionsByThread.delete(threadId);
    return;
  }
  const sessions = sessionsByThread.get(threadId);
  sessions?.delete(providerInstanceId);
  if (sessions?.size === 0) sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
