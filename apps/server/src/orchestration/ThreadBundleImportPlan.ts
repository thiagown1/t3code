import {
  ThreadBundleImportError,
  type ProviderInstanceId,
  type ThreadBundle,
  type ThreadBundleImportPlan,
} from "@t3tools/contracts";
import {
  buildThreadBundleImportPlan,
  threadBundleTargetThreadId,
} from "@t3tools/shared/threadBundle";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { prepareThreadBundleAttachments } from "./ThreadBundleAttachmentStore.ts";

function snapshotError(): ThreadBundleImportError {
  return new ThreadBundleImportError({
    reason: "snapshot-failed",
    message: "Failed to read the destination state for Thread Bundle import",
  });
}

export function planThreadBundleImportFromProjection(
  bundle: ThreadBundle,
  projection: Pick<ProjectionSnapshotQueryShape, "getProjectShells" | "getThreadDetailById">,
  availableProviderInstanceIds: ReadonlyArray<ProviderInstanceId>,
): Effect.Effect<ThreadBundleImportPlan, ThreadBundleImportError> {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => prepareThreadBundleAttachments(bundle),
      catch: () =>
        new ThreadBundleImportError({
          reason: "blocked",
          message: "Thread Bundle attachment integrity validation failed",
        }),
    });
    const projects = yield* projection.getProjectShells().pipe(Effect.mapError(snapshotError));
    const existingOrigins: Array<{
      readonly sourceEnvironmentId: string;
      readonly sourceThreadId: (typeof bundle.threads)[number]["sourceThreadId"];
    }> = [];

    for (const thread of bundle.threads) {
      const existing = yield* projection
        .getThreadDetailById(threadBundleTargetThreadId(thread))
        .pipe(Effect.mapError(snapshotError));
      if (Option.isSome(existing)) {
        existingOrigins.push({
          sourceEnvironmentId: thread.sourceEnvironmentId,
          sourceThreadId: thread.sourceThreadId,
        });
      }
    }

    const providerInstanceIds = availableProviderInstanceIds.map(String);
    return yield* Effect.try({
      try: () =>
        buildThreadBundleImportPlan({
          bundle,
          targetProjects: projects.map((project) => ({
            projectId: project.id,
            title: project.title,
            ...(project.repositoryIdentity?.canonicalKey
              ? { repositoryCanonicalKey: project.repositoryIdentity.canonicalKey }
              : {}),
            providerInstanceIds,
          })),
          existingOrigins,
        }),
      catch: () =>
        new ThreadBundleImportError({
          reason: "blocked",
          message: "Thread Bundle import plan could not be generated safely",
        }),
    });
  });
}
