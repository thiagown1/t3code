# FirstMate domain foundation

FirstMate organizes durable work without replacing the existing orchestration
state. A workspace is scoped to one project, topics link to existing threads,
and decisions reference provider-agnostic user-input, approval, or FirstMate
sources.

The contract and pure domain functions live in `packages/contracts` and
`packages/shared`. Commands are validated before the decider emits typed facts;
the projector reconstructs workspace state by replaying those facts. Accepted
facts are wrapped in the existing `firstmate.domain-event` orchestration
envelope. They use the project aggregate, so command receipts, idempotency,
event persistence, and projection updates remain part of the same transactional
path. FirstMate must not grow into a separate event store.

## Persistent facts versus derived state

Topic title, summary, stage, delegation, linked thread, and decision lifecycle
are persistent facts. Operational status is a read-model concern. It is derived
from the topic stage plus the linked thread's session, pending user input,
approvals, background liveness, and delivery status.

The derivation prioritizes a user decision, then an operator-owned delivery
gate, then execution failure and background liveness. A completed topic can
therefore correctly appear as `waiting-deploy` or `monitoring` without changing
the provider session lifecycle or implying that a deployment happened.

Machine alerts are aggregate read facts. They can be shown next to a topic, but
they never restart a service, clean a disk, signal a process, or otherwise
perform remediation.

## Persistence and compatibility

The project projection stores the replayed workspace in `firstmate_json`.
Existing rows migrate to `NULL`, and older snapshots remain valid because the
field is optional at the transport boundary. A project-created event initializes
an empty workspace; subsequent facts update it through the same pure projector
used by command replay.

The orchestration envelope is authoritative for aggregate identity and
`occurredAt`. Projectors ignore a FirstMate envelope attached to another
aggregate kind and normalize the nested fact timestamp to the persisted envelope
timestamp. This keeps deterministic replay even if malformed or legacy nested
payload metadata disagrees.

Shell clients receive a project upsert when a FirstMate fact commits. Clients
consume the projected workspace and derived topic summaries; they do not replay
an independent client-side history.

## Web topic panel

The web sidebar derives its FirstMate topic rows directly from project and
thread shell snapshots. A linked thread contributes session state, pending user
input, approvals, background liveness, and delivery status; pending FirstMate
decisions come from the project workspace. This lets a topic move to states such
as `waiting-user` or `waiting-deploy` in place when the shell stream updates.

The compact panel distinguishes three states: an older server omits the
FirstMate field and is unavailable, a current server returns `null` for a
migrated workspace with no facts yet, and a populated workspace supplies the
topic list. Topic rows expose title, summary, responsible agent, project when
needed, last update, pending-decision count, and a link to the delegated thread.
Resource-alert counts remain zero until environment telemetry is joined into
this read model; the panel must not imply that machine coverage exists before
that integration is present.

## Global decision inbox

Pending FirstMate decisions are aggregated across the visible project scope and
shown above the topic panel. Blocking decisions sort first. Each row keeps its
topic, responsible agent, impact descriptions, recommendation, and linked
thread navigation visible without requiring the user to find the original chat
message.

The supervisor chat renders the same pending decisions as cards above its
composer, narrowed to that project. Both surfaces build on the one inbox model
so aggregation and blocking-first ordering cannot drift apart.

Resolving a decision records the selected persisted option, rather than only a
generic resolved flag. Existing stored decisions and events decode with a null
selection for backward compatibility. After a successful resolve or cancel
receipt, the web client refreshes the authoritative environment shell once. This
keeps the inbox consistent with older or reconnecting shell subscriptions
without adding a polling loop. The inbox intentionally does not invent provider
replies: delivering the recorded answer into a provider approval, user-input
request, or a new agent turn belongs to deterministic routing and must be
fail-closed when the source cannot be mapped exactly.

## Deterministic topic routing

The selected topic is a durable workspace fact. The sidebar exposes one
explicit active-topic control for delegated topics; selection is persisted by a
typed project command and replayed with the other FirstMate facts. Workspaces
stored before this field existed decode with no selected topic.

The pure router uses the selected topic by default. A canonical
`@topic:<encoded-topic-id>` mention overrides it only when exactly one known
topic is named. Missing selections, unknown or multiple mentions, stale topic
references, and topics without a linked thread return `needs-confirmation`
instead of guessing. The supervisor composer consumes that result: a routed
message starts a turn in the destination thread and records a routing receipt,
and anything else becomes an explicit topic confirmation above the composer.

Routing only engages when the project has a supervisor thread, so the link is
what turns FirstMate on. Clients set it with `firstmate.supervisor.link`, from
the sidebar panel and the command palette, and clear it by linking `null`. There
is no separate unlink command.

## Supervisor tools over MCP

The supervisor creates topics, updates and delegates them, and opens decisions
through the `firstMate` MCP toolkit. Effect's MCP server registers toolkits once
for the whole process, so these tools are listed on every thread and cannot be
filtered per session. They are instead gated inside each handler on the live
`supervisorThreadId` of the invoking thread's project, which is deliberately not
an `McpCapability`: a capability is stamped when the provider session starts, and
linking or unlinking a supervisor mid-session has to take effect immediately.

The handlers mint topic and decision ids and translate a decider rejection back
into the agent's error channel verbatim, because the rejection reason is the only
thing that tells the agent what to do differently.

## PR ownership and automatic continuation

PR supervision belongs to the existing thread/PR link, not to an independent
scheduler database. Registration, resume budget and deduplication keys replay
with link events. One internal command consumes a resume and emits the user
message and turn-start request together; duplicate receipts cannot spend twice.
A separate drainable supervision worker runs at most two adapters per pass, including archived owners; slow adapters never block host refreshes. It waits for
active turns, queued work, approvals and user questions before resuming.

The first adapter is the reviewed Turbo Station `next/scripts/ci/pr-supervisor.cjs`.
It owns GitHub evidence and the shared fast-forward-only writer register used
by both Coder workflows. A ready host snapshot alone must never authorize a
writer. Enrollment is off until the repository operator enables
`FIRSTMATE_PR_SUPERVISION_ENABLED`; installing T3 alone does not activate it.

No clock-based lock stealing is allowed. Restarted T3 reuses the persisted
owner, acquisition SHA, and enrolled PR head, bound to its environment identity and database path. A same-branch push is first recorded as a revision change under that writer; only a later observation may evaluate gates for the new head. Every new enrollment creates a fresh owner UUID; it is not a reusable thread ID. Inspection without a saved acquisition SHA only recovers a lost response for that one registration. A copied database
cannot acquire, resume or release that owner from a different home. If T3 is unavailable, Coder cannot assume its writer died. Stop/archive,
closed PRs or exhausted supervision release ownership only after the thread is
idle. Deletion and unlinking are refused until release has been persisted.
The adapter is executed in the enrolled thread checkout, which must contain the
reviewed implementation; this pilot is for trusted implementation workspaces,
not untrusted fork reviews. Other repositories need a reviewed adapter before
enrollment. Three resumes/two hours bound this pilot, not provider dollar spend.
