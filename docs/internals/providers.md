# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

Context-window telemetry follows the same boundary. Adapters normalize provider usage into
`context-window.updated` activities; clients derive the newest valid snapshot and share one
presentation model across web and mobile. Compact surfaces may round counts, but detail surfaces
must preserve exact provider values and label omitted fields instead of estimating them.
Compaction history is reconstructed from durable `context-compaction` activities. A correlated
request id marks a manual compaction; an uncorrelated provider event is presented as
provider-native. Before/after counts remain optional because not every provider reports them.

Portable capability profiles are versioned, secret-free policy manifests. Their declarations may
reference only a local credential identifier and resolver kind; credential material never belongs
in the manifest. Effective access is fail-closed: the most-specific declaration must be enabled,
the current machine must report the integration available, and the current action must be
separately authorized. Missing or equally specific conflicting declarations are denied.
Each server persists its own optional profile in environment settings. The Integrations panel can
export that profile or import one through a validate, dry-run diff, and explicit-confirmation flow.
Import replaces the complete profile so removed declarations cannot survive unnoticed; an absent
profile grants no capabilities. Import/export does not resolve credentials or prove availability
or authorization, which remain independent runtime gates.

Environment Bundles extend that policy with a versioned, canonical inventory of MCP servers,
skills, plugins/apps, provider instances, project-instruction hashes, and the initial skill-context
budget. Bundles contain only logical paths, configuration references, credential references, and
content hashes. Absolute or escaping paths, duplicate identities, and conflicting MCP allow/block
rules are rejected. A bundle dry run compares every inventory independently; it is not permission
to install, enable, restart, or mutate an environment. Runtime health remains explicit as
`configured`, `missing-credential`, `unavailable`, `disabled`, or `ready`, and only a completed
health check can produce `ready`.

The Integrations panel builds its export from the selected server's live provider inventory and,
when available, the workspace-scoped skill snapshot for that checkout. It converts project skill
paths to relative logical paths and infers plugin/app identities without serializing user or
installation paths. Import always starts with a canonical dry run that lists each add, update, and
remove operation and marks provider reloads and required health checks. The reviewed bundle can
apply its capability profile only when no other environment component would change; MCPs, skills,
plugins/apps, instructions, and context budgets remain atomic blockers until their safe destination
adapters exist. An existing provider instance may be disabled in the same atomic settings patch;
its opaque local configuration is preserved. Provider creation, removal, metadata changes, and
enablement remain blocked until a health-checked adapter with rollback exists. The server hashes known
root instruction files without returning their contents or absolute paths, and marks that coverage
as partial until provider adapters report the exact files loaded by a session. MCP inventory stays
explicit about coverage. The Codex adapter scans only MCP table names, `enabled`, `enabled_tools`,
and `disabled_tools` from the configured user home and root project config. Commands, arguments,
URLs, environment values, tokens, absolute paths, and unrecognized fields are discarded before the
inventory or its hash is built. Single-line allow/block lists are supported; other providers and
more complex TOML remain partial. The browser must not derive inventory from raw provider config.
Nested Codex MCP `env` tables contribute only their variable names as portable
`environment-variable` credential references. Values are never returned or hashed; destinations
must resolve each name from their own environment before any future enablement adapter may report
the MCP as ready. Inline or provider-specific credential layouts remain outside the partial scan.
The inventory dialog exposes logical identities, enabled state, origin, coverage, and abbreviated
instruction hashes so operators can inspect what a bundle would contain before exporting it.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).
