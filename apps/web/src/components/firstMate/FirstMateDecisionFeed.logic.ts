import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";

import {
  buildFirstMateDecisionInboxModel,
  type FirstMateDecisionInboxItem,
} from "./FirstMateDecisionInbox.logic";

export interface FirstMateChatDecisionFeed {
  /** False everywhere except the thread the project linked as its supervisor. */
  readonly isSupervisorThread: boolean;
  readonly items: ReadonlyArray<FirstMateDecisionInboxItem>;
}

const EMPTY_FEED: FirstMateChatDecisionFeed = { isSupervisorThread: false, items: [] };

/**
 * The supervisor chat shows the same pending decisions as the cross-project
 * sidebar inbox, narrowed to the project the thread belongs to. Aggregation and
 * blocking-first ordering stay in the inbox model so both surfaces cannot drift.
 */
export function buildFirstMateChatDecisionFeed(input: {
  readonly project: EnvironmentProject | null | undefined;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly activeThreadId: ThreadId | null | undefined;
}): FirstMateChatDecisionFeed {
  const project = input.project;
  const workspace = project?.firstMate;
  if (
    project === null ||
    project === undefined ||
    workspace === null ||
    workspace === undefined ||
    input.activeThreadId == null ||
    workspace.supervisorThreadId !== input.activeThreadId
  ) {
    return EMPTY_FEED;
  }
  const { items } = buildFirstMateDecisionInboxModel({
    projects: [project],
    threads: input.threads,
    scopedProjectKeys: new Set([`${project.environmentId}:${project.id}`]),
  });
  return { isSupervisorThread: true, items };
}
