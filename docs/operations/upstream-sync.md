# Syncing the fork with upstream

This fork tracks `pingdotgg/t3code`. Drift is fast — a few days of upstream work is
comfortably over a hundred commits — and the cost of a sync is dominated by two
things that do not show up in a commit count: conflicts, and new upstream
migrations landing near the ids this fork reserves.

Two pieces cover it. One tells you every morning how expensive today's sync would
be; the other prepares the merge locally. Neither pushes, opens a pull request, or
moves `firstmate`.

## Daily report

`.github/workflows/upstream-drift.yml` runs at 06:40 UTC and on demand
(`workflow_dispatch`, with a `base` input if you want to measure another branch).
It fetches upstream and probes the merge with `git merge-tree`, which writes no
refs and no files, so the workflow cannot change a branch even by accident.

Where it reports:

- **The run's step summary** always carries the full report.
- **One issue**, labelled `upstream-sync`, is rewritten in place every day. Its
  title is the headline — `Upstream sync: 106 behind, 9 conflicting files` — so
  the issue list answers the question without opening anything. A new issue is
  only created when no open one carries the label.
- **A comment** is posted only when the situation changes for the worse, because
  a comment is the only part of this that notifies. A week of identical drift
  stays quiet.

The report leads with new upstream migrations, if any. That is the item that once
nearly cost a developer their database, and it is graded:

- `reserved-range` — upstream numbered at or above 900, the range this fork
  reserves. Do not merge before renumbering.
- `collision` — upstream claimed an id a fork-only migration already holds.
- `new` — a plain new upstream migration. Read
  `apps/server/src/persistence/MigrationLedger.ts` before merging.

The workflow needs no install: the report script and its library import only Node
builtins. Keep it that way — an Effect import turns a one-minute job into a full
`pnpm install`.

The branch being measured has to exist on the fork remote. Nothing runs against a
branch that only lives on someone's laptop.

## Local sync

```bash
vp run sync:upstream              # fetch, branch, merge, scoped checks
vp run sync:upstream --dry-run    # report only: no branch, no merge
vp run sync:upstream --skip-checks
```

It refuses before touching anything if the working tree is dirty, if a merge or
rebase is already in progress, or if the promisor requirement below is unmet.
Otherwise it branches `sync/upstream-YYYYMMDD` off `firstmate` and merges
`upstream/main`.

- **On conflict** it stops, lists the conflicting files, and leaves the tree
  exactly as git left it. Resolving is yours; the script will not guess. Exit
  code 2.
- **On a clean merge** it runs `typecheck` and `test` for the affected workspace
  packages only, never the whole repo, and reports what changed. Exit code 3 if a
  check fails.

Either way it warns about new upstream migrations and about `pnpm-workspace.yaml`,
where upstream's `msgpackr-extract: set this to true or false` placeholder breaks
`vp i` if it survives the merge.

Pushing, opening the pull request, and deciding whether the sync is worth landing
stay manual. The script prepares; you decide.

## Partial clone requirement

Checkouts of this fork are usually partial (`blob:none`) with `origin` as the
promisor remote. A merge from upstream needs blobs only upstream has, and git
will not fetch them lazily from a remote it does not consider a promisor:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git
git config remote.upstream.promisor true
```

`vp run sync:upstream` checks this and refuses with the same commands rather than
failing halfway through a merge. CI clones in full, so the workflow does not care.
