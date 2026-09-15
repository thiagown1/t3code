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
