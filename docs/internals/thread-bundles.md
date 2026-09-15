# Thread Bundles

A Thread Bundle is a versioned JSON envelope for copying selected conversations between T3
installations. It is deliberately independent from an Environment Bundle: importing conversation
content never grants a capability, installs an integration, or restores credentials.

Version 1 carries the source environment/thread identity, a portable project reference, minimal
model preferences, completed messages, attachment metadata, proposed plans, and resolved FirstMate
decisions. It does not represent provider sessions, processes, locks, checkpoints, activities,
pending or cancelled decisions, approvals, message context, worktree paths, attachment contents, or
snapshot accessibility metadata. Every omission is counted in the exported thread so the review can
explain what will not be copied. Free-form message and plan text is user-selected content and must be
reviewed before sharing the bundle outside the destination installation.

Attachment entries are `reference-only` in v1. They preserve enough metadata for review, but do not
claim that a file can be restored until a future integrity-checked asset adapter includes its
content. Active streaming messages are omitted instead of exporting a partial turn.

The canonical serializer sorts threads, plans, decisions, and omission summaries while preserving
message order. It rejects duplicate source origins and duplicate message, plan, or decision IDs.
The dry-run planner maps projects by canonical repository identity (or source project ID when no
repository identity exists), detects duplicates, missing or ambiguous projects, and unavailable
provider instances. Imported thread IDs are deterministic from the source environment and thread
identity, so importing the same origin twice is detectable without inspecting message content.
Import is fail-closed unless every selected thread is ready.

The read-only `server.planThreadBundleImport` RPC evaluates the supplied bundle against one
authoritative projection snapshot and the enabled provider registry. It returns the target project,
deterministic target thread ID, portable-content counts, omission count, and readiness reason for
every selected thread. It does not create threads, bind provider sessions, or write any target state;
server persistence and UI confirmation remain separate adapters.

Settings > Integrations exposes this dry run under **Conversation portability**. The review accepts a
Thread Bundle v1 file or pasted JSON, validates it locally, and then requests the authoritative plan.
It shows every source thread and destination status rather than collapsing a blocked batch into one
generic error. A ready plan still has no apply action until the atomic persistence adapter exists.

The read-only `server.exportThreadBundle` RPC accepts one to fifty unique thread IDs. It reads each
full persisted projection snapshot, resolves its project, selects only FirstMate decisions whose
topic is linked to that thread, and applies the shared sanitizer before returning the bundle. A
missing thread/project or failed snapshot aborts the whole export. The RPC requires orchestration
read scope and never starts, resumes, interrupts, or mutates a provider session.

The web thread-action menu exposes `Export Thread Bundle…` in both the sidebar and chat header. It
prepares the sanitized snapshot first, then presents the portable-content counts, attachment
limitations, and every omission category before download. Cancelling that review creates no file;
confirming downloads the canonical JSON with a filesystem-safe name. The review also warns that
free-form message and plan text can still contain sensitive information.
