import type { ModelSelection, ServerProvider, ServerSettings, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { resolveDefaultProviderModelSelection } from "../../providerInstances";

/**
 * Model for a new FirstMate chat: the FirstMate model setting, else the
 * project's new-thread model, healed to a provider that is actually usable.
 */
export function resolveFirstMateModelSelection(input: {
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly project: EnvironmentProject;
}): ModelSelection | null {
  const resolved = resolveProjectSettings(input.settings, input.project.id, input.project).settings;
  return resolveDefaultProviderModelSelection(
    input.providers,
    resolved.firstMateModelSelection ?? resolved.defaultModelSelection,
  );
}

/** The project's live FirstMate chat, or null when it must be (re)created. */
export function liveFirstMateThreadId(
  project: EnvironmentProject,
  hasThread: (threadId: ThreadId) => boolean,
): ThreadId | null {
  const threadId = project.firstMate?.supervisorThreadId ?? null;
  return threadId !== null && hasThread(threadId) ? threadId : null;
}
