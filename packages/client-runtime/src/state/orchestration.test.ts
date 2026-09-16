import { ProviderDriverKind, ThreadId, type ThreadCleanupPreview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadCleanupConfirmationMessage } from "./orchestration.ts";

const linkedPreview = {
  threadId: ThreadId.make("thread-1"),
  local: {
    archive: { outcome: "archived", reversible: true },
    tombstone: { outcome: "tombstoned", reversible: false },
    terminalHistory: { archive: "preserved", tombstone: "deleted" },
    attachments: { archive: "preserved", tombstone: "deleted" },
    eventStoreAudit: "retained",
  },
  provider: {
    status: "linked",
    provider: ProviderDriverKind.make("codex"),
    capabilities: {
      archive: "supported",
      unarchive: "known-not-implemented",
      delete: "known-not-implemented",
    },
    transcript: { archiveLocal: "preserved", tombstoneLocal: "preserved" },
  },
  irreversible: {
    archiveLocal: false,
    tombstoneLocal: true,
    deleteTerminalHistory: true,
    deleteAttachments: true,
    deleteRemoteConversation: false,
  },
} satisfies ThreadCleanupPreview;

describe("threadCleanupConfirmationMessage", () => {
  it("states that archive preserves local data and only attempts supported provider cleanup", () => {
    const message = threadCleanupConfirmationMessage(linkedPreview, {
      action: "archive",
      title: "Release prep",
    });

    expect(message).toContain('Archive thread "Release prep"?');
    expect(message).toContain(
      "Conversation history, terminal history, attachments, and the audit log stay available.",
    );
    expect(message).toContain("T3 will attempt to archive the Codex provider conversation.");
    expect(message).toContain("the actual outcome is recorded in the archive receipt");
    expect(message).not.toContain("will also be archived");
    expect(message).not.toContain("permanently");
  });

  it("describes local delete as a tombstone while provider and audit records remain", () => {
    const message = threadCleanupConfirmationMessage(linkedPreview, {
      action: "tombstone",
      title: "Release prep",
    });

    expect(message).toContain('Remove thread "Release prep" from T3?');
    expect(message).toContain("terminal history and stored attachments");
    expect(message).toContain("Conversation records remain in the audit log.");
    expect(message).not.toContain("tombstone");
    expect(message).toContain("The Codex provider conversation and transcript stay unchanged.");
    expect(message).toContain("This cannot be undone in T3.");
    expect(message).not.toContain("permanently clears");
  });

  it("uses a conservative confirmation for older remote servers", () => {
    const archiveMessage = threadCleanupConfirmationMessage(null, {
      action: "archive",
      title: "Remote thread",
    });
    const tombstoneMessage = threadCleanupConfirmationMessage(null, {
      action: "tombstone",
      title: "Remote thread",
    });

    expect(archiveMessage).toContain("This older server cannot preview provider cleanup.");
    expect(archiveMessage).toContain("provider-side outcome is unknown");
    expect(tombstoneMessage).toContain(
      "This action does not request deletion of a provider conversation.",
    );
  });

  it.each([
    ["claudeAgent", "Claude"],
    ["cursor", "Cursor"],
    ["grok", "Grok"],
    ["opencode", "OpenCode"],
    ["antigravity", "Antigravity"],
  ])("uses the product label for the %s provider", (provider, label) => {
    const preview = {
      ...linkedPreview,
      provider: {
        ...linkedPreview.provider,
        provider: ProviderDriverKind.make(provider),
        capabilities: {
          archive: "unsupported" as const,
          unarchive: "unsupported" as const,
          delete: "unsupported" as const,
        },
      },
    } satisfies ThreadCleanupPreview;

    expect(
      threadCleanupConfirmationMessage(preview, { action: "archive", title: "Provider labels" }),
    ).toContain(`The ${label} provider conversation`);
  });
});
