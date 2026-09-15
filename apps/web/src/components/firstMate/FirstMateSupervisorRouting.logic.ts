import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  FirstMateMessageRoutingFailure,
  FirstMateMessageRoutingResult,
} from "@t3tools/shared/firstMate";
import { routeFirstMateMessage } from "@t3tools/shared/firstMate";
import type { FirstMateTopicId, ThreadId } from "@t3tools/contracts";

export type FirstMateSupervisorRoutingFailure =
  | FirstMateMessageRoutingFailure
  | "composer-context-not-supported"
  | "destination-thread-not-found";

export type FirstMateSupervisorSubmissionPlan =
  | { readonly status: "passthrough" }
  | {
      readonly status: "routed";
      readonly topicId: FirstMateTopicId;
      readonly target: EnvironmentThreadShell;
      readonly message: string;
      readonly reason: Extract<FirstMateMessageRoutingResult, { status: "routed" }>["reason"];
    }
  | {
      readonly status: "needs-confirmation";
      readonly reason: FirstMateSupervisorRoutingFailure;
      readonly candidateTopicIds: ReadonlyArray<FirstMateTopicId>;
      readonly message: string;
    };

export function planFirstMateSupervisorSubmission(input: {
  readonly project: EnvironmentProject;
  readonly activeThreadId: ThreadId;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly message: string;
  readonly hasComposerContext: boolean;
}): FirstMateSupervisorSubmissionPlan {
  const workspace = input.project.firstMate;
  if (
    workspace === null ||
    workspace === undefined ||
    workspace.supervisorThreadId !== input.activeThreadId
  ) {
    return { status: "passthrough" };
  }

  const route = routeFirstMateMessage(workspace, input.message);
  if (route.status === "needs-confirmation") {
    return { ...route, message: input.message };
  }
  if (input.hasComposerContext) {
    return {
      status: "needs-confirmation",
      reason: "composer-context-not-supported",
      candidateTopicIds: [route.topicId],
      message: input.message,
    };
  }

  const target = input.threads.find(
    (thread) =>
      thread.environmentId === input.project.environmentId &&
      thread.projectId === input.project.id &&
      thread.id === route.threadId &&
      thread.archivedAt === null,
  );
  if (target === undefined) {
    return {
      status: "needs-confirmation",
      reason: "destination-thread-not-found",
      candidateTopicIds: [route.topicId],
      message: input.message,
    };
  }

  return { ...route, target };
}
