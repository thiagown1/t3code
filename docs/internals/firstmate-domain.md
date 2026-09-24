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
shown above the topic panel. Blocking decisions sort first. Each row names where
the card came from - the owning topic when there is one, otherwise the thread
that asked - alongside the responsible agent or provider, impact descriptions,
recommendation, and linked thread navigation, without requiring the user to find
the original chat message. A card that can name neither a topic nor a thread the
client can see is dropped: answering a question with no visible origin is
deciding in the dark, and delivery would refuse that thread anyway.

The supervisor chat renders the same pending decisions as cards above its
composer, narrowed to that project. Both surfaces build on the one inbox model
so aggregation and blocking-first ordering cannot drift apart.

The supervisor chat's Decisions panel is a queue rather than a list: it adds
work that needs the user without a card (a failed or interrupted delegated run,
a delegated PR with failing, action-required or conflicting checks, a pending
provider request with no card yet) and walks it one item at a time. Priority
comes from `firstMateQueuePriority` in `FirstMateDecisionQueue.logic.ts`: a
paused agent first, then turn reviews by the judge's outcome and confidence
(persisted on the card as `source.verdict`), supervisor questions, failed runs,
PR checks, and last the reviews where the judge leaned towards acting alone;
equal priorities put the newer item first. The item on screen is pinned: new or
more urgent items only reorder the list behind it. A reply goes to the thread as
a queued message (`after-current-turn`), so it never interrupts a running turn.

A turn-review card asks about a turn that has ended, so starting the next turn
cancels it in the decider, whether the user replied in the thread or from the
queue. While a thread runs, the topic panel also ignores its PR-derived status
(each PR still shows its own), so a working thread never reads as "waiting for
you" or "blocked".

Resolving a decision records the selected persisted option, rather than only a
generic resolved flag. Existing stored decisions and events decode with a null
selection for backward compatibility. After a successful resolve or cancel
receipt, the web client refreshes the authoritative environment shell once. This
keeps the inbox consistent with older or reconnecting shell subscriptions
without adding a polling loop.

Delivering that answer is a separate, fail-closed step owned by
`FirstMateDecisionDeliveryReactor`. A decision a supervisor opened names the
asking thread in its source, so the answer is queued back on that thread as an
ordinary message and drains with or without a connected client. A decision whose
source is a native `user-input` or `approval` request is answered on that request
instead. Every unmappable source — an imported decision, a deleted or archived
asker, an asker in another project, an option id that is not in the decision —
is refused and logged rather than guessed.

## Provider requests as decisions

Any thread in a project with a FirstMate workspace can block on a native
approval or user-input request. `FirstMateRequestDecisionReactor` lifts those
into the same inbox so the supervisor is one place to look, and
`FirstMateDecisionDeliveryReactor` answers them on the original request.

A pending request belongs to the thread that raised it, not to a topic, so
`FirstMateDecision.topicId` is nullable and a card carries a topic only when one
is delegated to its thread. Scoping the projection to delegated threads was the
original design and it made the inbox empty for the user it exists for: running
several threads with nothing delegated is the normal case. The supervisor thread
is still excluded, so it never becomes a source of its own inbox.

The direction matters and is the whole reason this is safe. Mapping an arbitrary
decision onto a provider request cannot be done exactly: decision option ids are
free text, `thread.approval.respond` takes one of five `ProviderApprovalDecision`
literals, and `thread.user-input.respond` takes a record keyed by question id, so
the final step would always be a guess — and a wrong guess authorizes work the
user never saw. `firstMateRequestDecisions` inverts it and builds the card _from_
the live request, so each option already corresponds to exactly one reply: an
approval option's id is its `decision` literal, and a user-input option's id is
that answer's position in the question. Requests the module cannot state exactly
— an approval with no provider options, a multi-question form, a multi-select
answer — produce no card and stay pending on their own thread.

The `user-input`/`approval` source therefore carries the originating `threadId`.
Without it an answer cannot be routed at all, because a provider request id is
unique only within one provider session and scanning threads for a match can
land on a different request. Decisions stored before the field existed decode as
`null` and are refused at delivery.

Each pass reconciles rather than reacts: it recomputes the thread's open
requests and makes the workspace match, using the same `openRequests` derivation
the decider uses to decide whether a thread is blocked on the user. That is what
makes it idempotent — the decision id is derived from thread plus request, so a
repeat is rejected as a duplicate — and what removes a card once the user answers
the request in the thread itself. It also means cancelling such a card from the
inbox is permanent for that request: the id already exists, so no later pass
re-raises it, which is how "leave this one to me" is expressed.

Request activity only ever catches threads that block after FirstMate is
watching. Switching FirstMate on, or restarting the server, usually finds
several threads already blocked, and those requests raise no new event - so
without a scan the inbox stays empty for exactly the person it exists for.
`firstmate.supervisor-linked` therefore scans its project, server start scans
every supervised project, and a topic being delegated re-checks the thread it
names. The scan is cheap by construction: the shell snapshot already records
`hasPendingApprovals` and `hasPendingUserInput`, and reading a thread's detail
is the expensive half of a pass, so a project of hundreds of settled threads
costs one snapshot and nothing more. It is parked off the boot path and, like
every pass, logs and moves on if it fails. Re-running it opens nothing twice,
because a card's id is derived from its thread and request.

A card leaves the inbox only when its request closed - never because delegation
moved, which would take a live question away from the user.

Delivery never trusts the stored card. It re-reads the source thread, requires
the request to still be open and to be of the kind the source claims, and
rebuilds the reply from the live request payload, checking the card's label
against it. Any mismatch is a refusal.

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

The supervisor creates topics, updates and delegates them, opens decisions, and
sends messages to a delegated topic's thread through the `firstMate` MCP
toolkit. A sent message is addressed by topic, never by a thread id the agent
supplies, so the toolkit cannot reach a thread the user's own topics do not
point at. Effect's MCP server registers toolkits once
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
