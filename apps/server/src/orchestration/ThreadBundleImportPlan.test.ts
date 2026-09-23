import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type ThreadBundle,
} from "@t3tools/contracts";
import { embedThreadBundleAttachments } from "@t3tools/shared/threadBundle";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { planThreadBundleImportFromProjection } from "./ThreadBundleImportPlan.ts";

const NOW = "2026-09-15T18:00:00.000Z";
const SOURCE_THREAD_ID = ThreadId.make("source-thread");
const TARGET_PROJECT_ID = ProjectId.make("target-project");

const bundle: ThreadBundle = {
  schemaVersion: 1,
  bundleId: "bundle-1",
  exportedAt: NOW,
  threads: [
    {
      sourceEnvironmentId: "source-environment",
      sourceThreadId: SOURCE_THREAD_ID,
      project: {
        sourceProjectId: ProjectId.make("source-project"),
        title: "Project",
        repositoryCanonicalKey: "github.com/acme/project",
      },
      title: "Imported conversation",
      preferredModel: {
        providerInstanceRef: "codex-work",
        model: "gpt-test",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      messages: [
        {
          sourceMessageId: MessageId.make("source-message"),
          role: "user",
          text: "Hello",
          attachments: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      proposedPlans: [],
      resolvedDecisions: [],
      omissions: [{ kind: "session", count: 1 }],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
};

const project = {
  id: TARGET_PROJECT_ID,
  title: "Project",
  repositoryIdentity: { canonicalKey: "github.com/acme/project" },
} as OrchestrationProjectShell;

function projection(input?: { readonly duplicate?: boolean; readonly fail?: boolean }) {
  return {
    getProjectShells: () =>
      input?.fail ? Effect.fail(new Error("query failed") as never) : Effect.succeed([project]),
    getThreadDetailById: () =>
      input?.fail
        ? Effect.fail(new Error("query failed") as never)
        : Effect.succeed(
            input?.duplicate
              ? Option.some({ id: ThreadId.make("existing") } as never)
              : Option.none(),
          ),
  } satisfies Pick<ProjectionSnapshotQueryShape, "getProjectShells" | "getThreadDetailById">;
}

describe("Thread Bundle import planning", () => {
  it.effect("maps a repository and available provider without writing destination state", () =>
    Effect.gen(function* () {
      const plan = yield* planThreadBundleImportFromProjection(bundle, projection(), [
        ProviderInstanceId.make("codex-work"),
      ]);

      expect(plan).toMatchObject({
        bundleId: "bundle-1",
        canImport: true,
        items: [
          {
            sourceEnvironmentId: "source-environment",
            sourceThreadId: SOURCE_THREAD_ID,
            targetProjectId: TARGET_PROJECT_ID,
            status: "ready",
            messageCount: 1,
            omissionCount: 1,
          },
        ],
      });
    }),
  );

  it.effect("fails the whole plan closed for duplicates or unavailable providers", () =>
    Effect.gen(function* () {
      const duplicate = yield* planThreadBundleImportFromProjection(
        bundle,
        projection({ duplicate: true }),
        [ProviderInstanceId.make("codex-work")],
      );
      const missingProvider = yield* planThreadBundleImportFromProjection(bundle, projection(), []);

      expect(duplicate).toMatchObject({ canImport: false, items: [{ status: "duplicate" }] });
      expect(missingProvider).toMatchObject({
        canImport: false,
        items: [{ status: "missing-provider" }],
      });
    }),
  );

  it.effect("returns a sanitized error when the destination snapshot cannot be read", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        planThreadBundleImportFromProjection(bundle, projection({ fail: true }), [
          ProviderInstanceId.make("codex-work"),
        ]),
      );

      expect(error).toMatchObject({
        _tag: "ThreadBundleImportError",
        reason: "snapshot-failed",
        message: "Failed to read the destination state for Thread Bundle import",
      });
    }),
  );

  it.effect("fails a v2 dry run closed when embedded attachment integrity is invalid", () =>
    Effect.gen(function* () {
      const metadataBundle = {
        ...bundle,
        threads: bundle.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) => ({
            ...message,
            attachments: [
              {
                sourceAttachmentId: "source-attachment",
                type: "file" as const,
                name: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: 5,
                availability: "reference-only" as const,
              },
            ],
          })),
          omissions: [...thread.omissions, { kind: "attachment-content" as const, count: 1 }],
        })),
      } satisfies ThreadBundle;
      const valid = embedThreadBundleAttachments(metadataBundle, () =>
        new TextEncoder().encode("notes"),
      );
      const invalid = {
        ...valid,
        threads: valid.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) => ({
            ...message,
            attachments: message.attachments.map((attachment) => ({
              ...attachment,
              ...(attachment.availability === "embedded" ? { sha256: "0".repeat(64) } : {}),
            })),
          })),
        })),
      } satisfies ThreadBundle;

      const error = yield* Effect.flip(
        planThreadBundleImportFromProjection(invalid, projection(), [
          ProviderInstanceId.make("codex-work"),
        ]),
      );
      expect(error).toMatchObject({
        _tag: "ThreadBundleImportError",
        reason: "blocked",
        message: "Thread Bundle attachment integrity validation failed",
      });
    }),
  );
});
