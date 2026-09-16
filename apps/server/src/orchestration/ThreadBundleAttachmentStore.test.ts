// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ProjectId, ThreadId, type ThreadBundle } from "@t3tools/contracts";
import { embedThreadBundleAttachments } from "@t3tools/shared/threadBundle";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { parseAttachmentFileExtension, resolveAttachmentPath } from "../attachmentStore.ts";
import {
  prepareThreadBundleAttachments,
  publishThreadBundleAttachments,
} from "./ThreadBundleAttachmentStore.ts";

const NOW = "2026-09-16T12:00:00.000Z";
const bytes = new TextEncoder().encode("portable attachment bytes");

const metadataBundle = {
  schemaVersion: 1,
  bundleId: "bundle-with-attachment",
  exportedAt: NOW,
  threads: [
    {
      sourceEnvironmentId: "source-environment",
      sourceThreadId: ThreadId.make("source-thread"),
      project: { sourceProjectId: ProjectId.make("source-project"), title: "Project" },
      title: "Imported conversation",
      preferredModel: { providerInstanceRef: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      messages: [
        {
          sourceMessageId: MessageId.make("source-message"),
          role: "user",
          text: "Inspect the attachment",
          attachments: [
            {
              sourceAttachmentId: "source-attachment",
              type: "file",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: bytes.length,
              availability: "reference-only",
            },
          ],
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      proposedPlans: [],
      resolvedDecisions: [],
      omissions: [{ kind: "attachment-content", count: 1 }],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
} satisfies ThreadBundle;

const bundle = embedThreadBundleAttachments(metadataBundle, () => bytes);

const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const imageMetadataBundle = {
  ...metadataBundle,
  bundleId: "bundle-with-image",
  threads: metadataBundle.threads.map((thread) => ({
    ...thread,
    messages: thread.messages.map((message) => ({
      ...message,
      attachments: [
        {
          sourceAttachmentId: "source-image",
          type: "image" as const,
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: imageBytes.length,
          availability: "reference-only" as const,
        },
      ],
    })),
  })),
} satisfies ThreadBundle;
const imageBundle = embedThreadBundleAttachments(imageMetadataBundle, () => imageBytes);

it.layer(NodeServices.layer)("Thread Bundle attachment store", (it) => {
  it.effect("publishes destination-local immutable files and reuses them on retry", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-thread-bundle-attachments-",
      });
      const first = prepareThreadBundleAttachments(bundle);
      const second = prepareThreadBundleAttachments(bundle);

      yield* Effect.all(
        [
          publishThreadBundleAttachments({ attachmentsDir, prepared: first }),
          publishThreadBundleAttachments({ attachmentsDir, prepared: second }),
        ],
        { concurrency: "unbounded" },
      );

      const attachment = first.attachmentsByMessage.values().next().value?.[0];
      expect(attachment).toBeDefined();
      expect(attachment?.id).not.toBe("source-attachment");
      const filePath = attachment ? resolveAttachmentPath({ attachmentsDir, attachment }) : null;
      expect(filePath).not.toBeNull();
      expect(filePath ? NodeFS.readFileSync(filePath) : null).toEqual(Buffer.from(bytes));
      expect(NodeFS.readdirSync(attachmentsDir).filter((entry) => entry.endsWith(".part"))).toEqual(
        [],
      );
    }),
  );

  it.effect("fails closed when a deterministic destination contains different bytes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-thread-bundle-conflict-",
      });
      const prepared = prepareThreadBundleAttachments(bundle);
      const attachment = prepared.attachmentsByMessage.values().next().value?.[0];
      expect(attachment).toBeDefined();
      const filePath = attachment ? resolveAttachmentPath({ attachmentsDir, attachment }) : null;
      expect(filePath).not.toBeNull();
      if (filePath) NodeFS.writeFileSync(filePath, "different");

      const error = yield* Effect.flip(
        publishThreadBundleAttachments({ attachmentsDir, prepared }),
      );
      expect(error).toMatchObject({
        _tag: "ThreadBundleAttachmentStoreError",
        message: "A destination attachment path already contains different content",
      });
      expect(filePath ? NodeFS.readFileSync(filePath, "utf8") : null).toBe("different");
    }),
  );

  it("keeps imported image ids extension-free for image asset resolution", () => {
    const prepared = prepareThreadBundleAttachments(imageBundle);
    const attachment = prepared.attachmentsByMessage.values().next().value?.[0];

    expect(attachment?.type).toBe("image");
    expect(parseAttachmentFileExtension(attachment?.id ?? "")).toBeNull();
    expect(
      attachment ? resolveAttachmentPath({ attachmentsDir: "assets", attachment }) : null,
    ).toMatch(new RegExp(`${attachment?.id}\\.png$`));
  });

  it("keeps metadata-only v1 imports file-free", () => {
    const prepared = prepareThreadBundleAttachments(metadataBundle);
    expect(prepared.files).toEqual([]);
    expect(prepared.attachmentsByMessage.size).toBe(0);
  });
});
