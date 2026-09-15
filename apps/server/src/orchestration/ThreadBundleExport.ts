import {
  ThreadBundleExportError,
  type FirstMateDecision,
  type OrchestrationProjectShell,
  type ThreadBundle,
  type ThreadBundleExportInput,
  type ThreadId,
} from "@t3tools/contracts";
import { buildThreadBundle } from "@t3tools/shared/threadBundle";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

function exportError(input: {
  readonly reason: ThreadBundleExportError["reason"];
  readonly message: string;
  readonly threadId?: ThreadBundleExportError["threadId"];
}): ThreadBundleExportError {
  return new ThreadBundleExportError({
    reason: input.reason,
    message: input.message,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  });
}

function decisionsForThread(
  project: OrchestrationProjectShell,
  threadId: ThreadId,
): ReadonlyArray<FirstMateDecision> {
  const state = project.firstMate;
  if (!state) return [];
  const topicIds = new Set(
    state.topics.filter((topic) => topic.threadId === threadId).map((topic) => topic.id),
  );
  return state.decisions.filter((decision) => topicIds.has(decision.topicId));
}

export function exportThreadBundleFromProjection(
  input: ThreadBundleExportInput & {
    readonly sourceEnvironmentId: string;
    readonly bundleId: string;
    readonly exportedAt: string;
  },
  projection: Pick<ProjectionSnapshotQueryShape, "getThreadDetailSnapshot" | "getProjectShellById">,
): Effect.Effect<ThreadBundle, ThreadBundleExportError> {
  return Effect.gen(function* () {
    const uniqueThreadIds = new Set(input.threadIds);
    if (uniqueThreadIds.size !== input.threadIds.length) {
      return yield* exportError({
        reason: "duplicate-thread",
        message: "Thread Bundle export contains a duplicate thread selection",
      });
    }

    const entries: Parameters<typeof buildThreadBundle>[0]["entries"][number][] = [];
    for (const threadId of input.threadIds) {
      const snapshot = yield* projection.getThreadDetailSnapshot(threadId).pipe(
        Effect.mapError(() =>
          exportError({
            reason: "snapshot-failed",
            message: "Failed to read the thread snapshot for export",
            threadId,
          }),
        ),
      );
      if (Option.isNone(snapshot)) {
        return yield* exportError({
          reason: "thread-not-found",
          message: "Thread not found for Thread Bundle export",
          threadId,
        });
      }
      const project = yield* projection.getProjectShellById(snapshot.value.thread.projectId).pipe(
        Effect.mapError(() =>
          exportError({
            reason: "snapshot-failed",
            message: "Failed to read the project snapshot for export",
            threadId,
          }),
        ),
      );
      if (Option.isNone(project)) {
        return yield* exportError({
          reason: "project-not-found",
          message: "Project not found for Thread Bundle export",
          threadId,
        });
      }
      entries.push({
        project: project.value,
        thread: snapshot.value.thread,
        decisions: decisionsForThread(project.value, threadId),
      });
    }

    return buildThreadBundle({
      bundleId: input.bundleId,
      exportedAt: input.exportedAt,
      sourceEnvironmentId: input.sourceEnvironmentId,
      entries,
    });
  });
}
