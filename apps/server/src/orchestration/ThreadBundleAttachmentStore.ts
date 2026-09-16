// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import {
  ChatAttachment,
  type ThreadBundle,
  type ThreadBundleEmbeddedAttachment,
  type ThreadId,
} from "@t3tools/contracts";
import {
  decodeThreadBundleAttachment,
  normalizeThreadBundle,
  threadBundleTargetThreadId,
} from "@t3tools/shared/threadBundle";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  attachmentFileExtension,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

export class ThreadBundleAttachmentStoreError extends Schema.TaggedError<ThreadBundleAttachmentStoreError>()(
  "ThreadBundleAttachmentStoreError",
  {
    message: Schema.String,
  },
) {}

interface PreparedAttachmentFile {
  readonly attachment: ChatAttachment;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PreparedThreadBundleAttachments {
  readonly attachmentsByMessage: ReadonlyMap<string, ReadonlyArray<ChatAttachment>>;
  readonly files: ReadonlyArray<PreparedAttachmentFile>;
}

const decodeChatAttachment = Schema.decodeUnknownSync(ChatAttachment, {
  onExcessProperty: "error",
});

export function threadBundleAttachmentMessageKey(input: {
  readonly sourceEnvironmentId: string;
  readonly sourceThreadId: ThreadId;
  readonly sourceMessageId: string;
}): string {
  return JSON.stringify([input.sourceEnvironmentId, input.sourceThreadId, input.sourceMessageId]);
}

function targetAttachmentId(input: {
  readonly sourceEnvironmentId: string;
  readonly sourceThreadId: ThreadId;
  readonly attachment: ThreadBundleEmbeddedAttachment;
}): string {
  const targetThreadId = threadBundleTargetThreadId({
    sourceEnvironmentId: input.sourceEnvironmentId,
    sourceThreadId: input.sourceThreadId,
  });
  const threadSegment = toSafeThreadAttachmentSegment(targetThreadId);
  if (!threadSegment) throw new Error("Thread Bundle target thread cannot own attachments");
  const digest = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        "thread-bundle-attachment-v2",
        input.sourceEnvironmentId,
        input.sourceThreadId,
        input.attachment.sourceAttachmentId,
        input.attachment.sha256,
      ]),
    )
    .digest("hex");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  const extensionSuffix =
    input.attachment.type === "file"
      ? `-${attachmentFileExtension(input.attachment.name).slice(1)}`
      : "";
  return `${threadSegment}-${uuid}${extensionSuffix}`;
}

/**
 * Decodes and validates every embedded file before any destination write. The
 * returned attachment metadata contains only destination-local references.
 */
export function prepareThreadBundleAttachments(
  bundle: ThreadBundle,
): PreparedThreadBundleAttachments {
  const normalized = normalizeThreadBundle(bundle);
  if (normalized.schemaVersion === 1) {
    return { attachmentsByMessage: new Map(), files: [] };
  }

  const attachmentsByMessage = new Map<string, ReadonlyArray<ChatAttachment>>();
  const filesById = new Map<string, PreparedAttachmentFile>();
  for (const thread of normalized.threads) {
    for (const message of thread.messages) {
      const attachments = message.attachments.map((portable) => {
        if (portable.availability !== "embedded") {
          throw new Error("Thread Bundle v2 attachment content is missing");
        }
        const bytes = decodeThreadBundleAttachment(portable);
        const id = targetAttachmentId({
          sourceEnvironmentId: thread.sourceEnvironmentId,
          sourceThreadId: thread.sourceThreadId,
          attachment: portable,
        });
        const attachment = decodeChatAttachment({
          type: portable.type,
          id,
          name: portable.name,
          mimeType: portable.mimeType,
          sizeBytes: portable.sizeBytes,
        });
        const existing = filesById.get(id);
        if (existing && existing.sha256 !== portable.sha256) {
          throw new Error("Thread Bundle attachment identity collision");
        }
        if (!existing) {
          filesById.set(id, { attachment, bytes, sha256: portable.sha256 });
        }
        return attachment;
      });
      attachmentsByMessage.set(
        threadBundleAttachmentMessageKey({
          sourceEnvironmentId: thread.sourceEnvironmentId,
          sourceThreadId: thread.sourceThreadId,
          sourceMessageId: message.sourceMessageId,
        }),
        attachments,
      );
    }
  }
  return { attachmentsByMessage, files: [...filesById.values()] };
}

function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function verifyPublishedFile(input: {
  readonly filePath: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
}): Effect.Effect<void, ThreadBundleAttachmentStoreError> {
  return Effect.try({
    try: () => {
      const info = NodeFS.lstatSync(input.filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== input.expectedBytes) {
        throw new Error("stored attachment metadata differs");
      }
      if (sha256(NodeFS.readFileSync(input.filePath)) !== input.expectedSha256) {
        throw new Error("stored attachment hash differs");
      }
    },
    catch: () =>
      new ThreadBundleAttachmentStoreError({
        message: "A destination attachment path already contains different content",
      }),
  });
}

function writeAndSync(filePath: string, bytes: Uint8Array): void {
  const descriptor = NodeFS.openSync(filePath, "w");
  try {
    NodeFS.writeFileSync(descriptor, bytes);
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

/**
 * Publishes immutable files before the event-store transaction. Published
 * files are deliberately not removed on later failure: a concurrent import or
 * an uncertain database receipt may already reference the deterministic path.
 */
export const publishThreadBundleAttachments = Effect.fn("publishThreadBundleAttachments")(
  function* (input: {
    readonly attachmentsDir: string;
    readonly prepared: PreparedThreadBundleAttachments;
  }): Effect.fn.Return<
    PreparedThreadBundleAttachments,
    ThreadBundleAttachmentStoreError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(input.attachmentsDir, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new ThreadBundleAttachmentStoreError({
            message: "Failed to prepare the destination attachment directory",
          }),
      ),
    );
    for (const file of input.prepared.files) {
      const finalPath = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment: file.attachment,
      });
      if (!finalPath || path.dirname(finalPath) !== path.resolve(input.attachmentsDir)) {
        return yield* new ThreadBundleAttachmentStoreError({
          message: "Thread Bundle attachment resolved outside the destination store",
        });
      }
      if (yield* fileSystem.exists(finalPath).pipe(Effect.orElseSucceed(() => false))) {
        yield* verifyPublishedFile({
          filePath: finalPath,
          expectedBytes: file.bytes.length,
          expectedSha256: file.sha256,
        });
        continue;
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporaryPath = yield* fileSystem.makeTempFileScoped({
            directory: input.attachmentsDir,
            prefix: ".thread-bundle-",
            suffix: ".part",
          });
          yield* Effect.try({
            try: () => writeAndSync(temporaryPath, file.bytes),
            catch: () =>
              new ThreadBundleAttachmentStoreError({
                message: "Failed to stage a Thread Bundle attachment",
              }),
          });
          const linked = yield* fileSystem.link(temporaryPath, finalPath).pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              cause.reason._tag === "AlreadyExists"
                ? Effect.succeed(false)
                : Effect.fail(
                    new ThreadBundleAttachmentStoreError({
                      message: "Failed to publish a Thread Bundle attachment",
                    }),
                  ),
            ),
          );
          if (!linked) {
            yield* verifyPublishedFile({
              filePath: finalPath,
              expectedBytes: file.bytes.length,
              expectedSha256: file.sha256,
            });
          }
        }),
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "ThreadBundleAttachmentStoreError"
            ? error
            : new ThreadBundleAttachmentStoreError({
                message: "Failed to finalize a Thread Bundle attachment",
              }),
        ),
      );
    }
    return input.prepared;
  },
);
