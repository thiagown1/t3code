import { layerTest as serverConfigLayerTest } from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { EnvironmentId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { supervisePrLink } from "./PrSupervisionSweep.ts";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type PullRequestRef,
  type PullRequestStack,
  type PullRequestSummary,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ServerActivation } from "../serverActivation.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as PullRequestSyncReactor from "./PullRequestSyncReactor.ts";
import { resolveAutoSettlementAt } from "./ThreadSettlementPolicy.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("sync-project");

type SyncCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.pull-request-link.sync" }
>;
type LinkCommand = Extract<OrchestrationCommand, { readonly type: "thread.pull-request.link" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(id: ProjectId = PROJECT_ID): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeLink(
  number: number,
  snapshot: Partial<ThreadPullRequestSnapshot> | null = null,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "owner/repository",
    number,
    url: `https://github.com/owner/repository/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      snapshot === null
        ? null
        : {
            state: "open",
            title: "Pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: "2026-08-27T00:00:00.000Z",
            syncedAt: "2026-08-27T00:00:00.000Z",
            ...snapshot,
          },
    stack: null,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  snapshotSequence = 1,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence,
    projects: [makeProject()],
    threads,
    updatedAt: NOW,
  };
}

function makeSummary(
  input: PullRequestRef,
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    provider: "github",
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://github.com/${input.repository}/pull/${input.number}`,
    state: "open",
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  readonly archivedSnapshot?: () => Effect.Effect<OrchestrationShellSnapshot>;
  readonly onDispatch?: (command: SyncCommand | LinkCommand) => Effect.Effect<void>;
  readonly invalidate?: PullRequestService["Service"]["invalidate"];
  readonly snapshot: OrchestrationShellSnapshot;
  readonly summary?: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestSummary, PullRequestOperationError>;
  readonly stack?: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestStack | null, PullRequestOperationError>;
}

const makeHarness = Effect.fn("makePullRequestSyncHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const snapshotReads = yield* Queue.unbounded<void>();
  const syncCommands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const linkCommands = yield* Ref.make<ReadonlyArray<LinkCommand>>([]);
  const summaryCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const stackCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);

  const summary: PullRequestService["Service"]["summary"] = (input, readOptions) =>
    Effect.gen(function* () {
      assert.strictEqual(readOptions?.recoverTransientFailure, false);
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      return yield* options.summary?.(input) ?? Effect.succeed(makeSummary(input));
    });

  const stack: PullRequestService["Service"]["stack"] = (input, readOptions) =>
    Effect.gen(function* () {
      assert.strictEqual(readOptions?.includeDetails, false);
      yield* Ref.update(stackCalls, (calls) => [...calls, input]);
      return yield* options.stack?.(input) ?? Effect.succeed(null);
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (command.type === "thread.pull-request-link.sync") {
      return Ref.update(syncCommands, (recorded) => [...recorded, command]).pipe(
        Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
        Effect.as({ sequence: 1 }),
      );
    }
    if (command.type === "thread.pull-request.link") {
      return Ref.update(linkCommands, (recorded) => [...recorded, command]).pipe(
        Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
        Effect.as({ sequence: 1 }),
      );
    }
    return Effect.die(new Error(`Unexpected command: ${command.type}`));
  };

  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Queue.offer(snapshotReads, undefined).pipe(Effect.andThen(Ref.get(snapshots))),
      getArchivedShellSnapshot:
        options.archivedSnapshot ?? (() => Effect.succeed(makeSnapshot([]))),
    }),
    Layer.mock(PullRequestService)({
      summary,
      stack,
      invalidate: options.invalidate ?? (() => Effect.void),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  return {
    events,
    activation,
    snapshots,
    snapshotReads,
    syncCommands,
    linkCommands,
    summaryCalls,
    stackCalls,
    layer: PullRequestSyncReactor.layer.pipe(
      Layer.provide(dependencies),
      Layer.provide(serverConfigLayerTest("/test", { prefix: "pr-supervision-" })),
      Layer.provide(NodeServices.layer),
    ),
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const startAndSweep = Effect.fn("startPullRequestSyncHarness")(function* (fixture: Harness) {
  const reactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  yield* reactor.start();
  yield* Deferred.succeed(fixture.activation, undefined);
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
  return reactor;
});

const sweepAgain = Effect.fn("sweepPullRequestSyncHarness")(function* (
  fixture: Harness,
  reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
) {
  yield* TestClock.adjust("1 minute");
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
});

/** What the reactor would have persisted, so the next sweep sees its own writes. */
function applySync(
  snapshot: OrchestrationShellSnapshot,
  commands: ReadonlyArray<SyncCommand>,
): OrchestrationShellSnapshot {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      pullRequests: thread.pullRequests.map((link) => {
        const command = commands.findLast(
          (candidate) => candidate.threadId === thread.id && candidate.number === link.number,
        );
        return command === undefined
          ? link
          : { ...link, snapshot: command.snapshot, stack: command.stack };
      }),
    })),
  };
}

describe("PullRequestSyncReactor", () => {
  it.effect("syncs a newly linked merged PR without waiting for the periodic sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one")]),
          summary: (input) =>
            Effect.succeed(makeSummary(input, { state: "merged", mergedAt: NOW })),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          const link = makeLink(42);
          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([makeThread("one", { pullRequests: [link] })]),
          );
          yield* PubSub.publish(fixture.events, {
            type: "thread.pull-request-linked",
            sequence: 2,
            eventId: EventId.make("linked"),
            aggregateKind: "thread",
            aggregateId: ThreadId.make("one"),
            occurredAt: NOW,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: { threadId: ThreadId.make("one"), link, updatedAt: NOW },
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.syncCommands))[0]?.snapshot.state, "merged");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
  it.effect("retries a failed stack read after the summary becomes terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        let attempts = 0;
        const nativeStack: PullRequestStack = {
          id: "stack",
          number: 7,
          url: "https://github.com/owner/repository/stacks/7",
          base: "main",
          layers: [{ number: 7, headBranch: "feature", state: "merged" }],
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(7)] })]),
          summary: (input) =>
            Effect.succeed(makeSummary(input, { state: "merged", mergedAt: NOW })),
          stack: () =>
            ++attempts === 1
              ? Effect.fail(
                  new PullRequestOperationError({
                    operation: "stack",
                    detail: "temporary failure",
                  }),
                )
              : Effect.succeed(nativeStack),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          const commands = yield* Ref.get(fixture.syncCommands);
          assert.deepStrictEqual(commands, []);
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, commands));
          yield* sweepAgain(fixture, reactor);
          assert.strictEqual(attempts, 2);
          assert.deepStrictEqual((yield* Ref.get(fixture.syncCommands)).at(-1)?.stack, {
            kind: "native",
            ...nativeStack,
          });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("retries a failed sibling link before publishing a terminal snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        let failSibling = true;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("one", { pullRequests: [makeLink(7, { state: "closed" })] }),
          ]),
          summary: (input) =>
            Effect.succeed(makeSummary(input, { state: "merged", mergedAt: NOW })),
          stack: () =>
            Effect.succeed({
              id: "stack",
              number: 7,
              url: "https://github.com/owner/repository/stacks/7",
              base: "main",
              layers: [
                { number: 7, headBranch: "feature", state: "merged" },
                { number: 8, headBranch: "sibling", state: "open" },
              ],
            }),
          onDispatch: (command) =>
            command.type === "thread.pull-request.link" && failSibling
              ? Effect.die("temporary link failure")
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.deepStrictEqual(yield* Ref.get(fixture.syncCommands), []);
          failSibling = false;
          yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands))[0]?.snapshot.state, "merged");
          assert.strictEqual((yield* Ref.get(fixture.linkCommands)).at(-1)?.number, 8);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("concurrent stack reads persist a shared sibling once before syncing both roots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readsReady = yield* Deferred.make<void>();
        let reads = 0;
        let linked = false;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(7), makeLink(8)] })]),
          stack: () =>
            Effect.gen(function* () {
              if (++reads === 2) yield* Deferred.succeed(readsReady, undefined);
              yield* Deferred.await(readsReady);
              return {
                id: "stack",
                number: 7,
                url: "https://github.com/owner/repository/stacks/7",
                base: "main",
                layers: [{ number: 9, headBranch: "sibling", state: "open" as const }],
              };
            }),
          onDispatch: (command) =>
            Effect.gen(function* () {
              if (command.type === "thread.pull-request.link") {
                yield* Effect.yieldNow;
                assert.strictEqual(linked, false);
                linked = true;
              } else {
                assert.strictEqual(linked, true);
              }
            }),
        });
        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.linkCommands)).length, 1);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("explicit refresh reads a changed stack even when its PR summary is unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(7, {})] })]),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 0);
          yield* reactor.requestSync({
            host: "github.com",
            repository: "owner/repository",
            number: 7,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
  it.effect("snapshots an unsynced link once and writes it to the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(42)] })]),
          summary: (input) =>
            Effect.succeed(
              makeSummary(input, {
                title: "Ship it",
                isDraft: true,
                headSha: "abc123def456",
                checksState: "pending",
                checks: [{ name: "CI", status: "pending", description: null, url: null }],
              }),
            ),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            {
              projectId: PROJECT_ID,
              host: "github.com",
              repository: "owner/repository",
              number: 42,
            },
          ]);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map(({ commandId: _, ...rest }) => rest),
            [
              {
                type: "thread.pull-request-link.sync",
                threadId: ThreadId.make("one"),
                host: "github.com",
                repository: "owner/repository",
                number: 42,
                snapshot: {
                  state: "open",
                  title: "Ship it",
                  headBranch: "feature",
                  headSha: "abc123def456",
                  baseBranch: "main",
                  isDraft: true,
                  updatedAt: "2026-08-27T00:00:00.000Z",
                  syncedAt: NOW,
                  closedAt: null,
                  mergedAt: null,
                  checksState: "pending",
                  checks: [{ name: "CI", status: "pending", description: null, url: null }],
                },
                stack: null,
              },
            ],
          );
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("asks the host once for a pull request shared by two threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("one", { pullRequests: [makeLink(42)] }),
            makeThread("two", {
              pullRequests: [makeLink(42, null, { repository: "Owner/Repository" })],
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          const commands = yield* Ref.get(fixture.syncCommands);
          assert.deepStrictEqual(
            commands
              .map((command) => [command.threadId, command.repository] as const)
              .sort((left, right) => left[0].localeCompare(right[0])),
            [
              [ThreadId.make("one"), "owner/repository"],
              [ThreadId.make("two"), "Owner/Repository"],
            ],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("recovers the HTTP port when syncing an older Forgejo link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("one", {
              pullRequests: [
                makeLink(42, null, {
                  host: "forge.example",
                  url: "http://forge.example:3000/owner/repository/pulls/42",
                }),
              ],
            }),
          ]),
          summary: (input) => Effect.succeed(makeSummary(input)),
        });
        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls))[0]?.host, "forge.example:3000");
          assert.strictEqual((yield* Ref.get(fixture.syncCommands))[0]?.host, "forge.example:3000");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("dispatches nothing when the host snapshot is unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(42)] })]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          const firstSweep = yield* Ref.get(fixture.syncCommands);
          assert.strictEqual(firstSweep.length, 1);
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, firstSweep));

          yield* sweepAgain(fixture, reactor);

          // Still open on an active thread, so the host was asked again, but nothing changed.
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 1);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("refreshes closed links through the reactor's project after reopening elsewhere", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stale = yield* Ref.make(true);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("first", { pullRequests: [makeLink(42, { state: "closed" })] }),
            makeThread("second", {
              projectId: ProjectId.make("second-project"),
              pullRequests: [makeLink(42, { state: "closed" })],
            }),
          ]),
          invalidate: ({ reference }) =>
            reference?.projectId === makeProject().id && reference.host === "github.com"
              ? Ref.set(stale, false)
              : Effect.void,
          summary: (input) =>
            Ref.get(stale).pipe(
              Effect.map((cached) => makeSummary(input, { state: cached ? "closed" : "open" })),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          yield* reactor.requestSync({
            host: "github.com",
            repository: "owner/repository",
            number: 42,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          const commands = yield* Ref.get(fixture.syncCommands);
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, commands));
          const snapshot = yield* Ref.get(fixture.snapshots);
          assert.deepStrictEqual(
            snapshot.threads.map((thread) => thread.pullRequests[0]?.snapshot?.state),
            ["open", "open"],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("stops asking the host once a pull request is merged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged", { pullRequests: [makeLink(1, { state: "merged" })] }),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* sweepAgain(fixture, reactor);

          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.syncCommands), []);

          yield* reactor.requestSync({
            host: "github.com",
            repository: "owner/repository",
            number: 1,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls)).map((call) => call.number),
            [1],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("discovers externally reopened pull requests after fifteen minutes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<"closed" | "open">("closed");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("closed", { pullRequests: [makeLink(2, { state: "closed" })] }),
          ]),
          summary: (input) =>
            Ref.get(state).pipe(Effect.map((state) => makeSummary(input, { state }))),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          yield* Ref.set(state, "open");
          for (let index = 0; index < 14; index += 1) yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).at(-1)?.snapshot.state, "open");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("preserves a refresh requested while an older host read is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          summary: (input) =>
            Effect.gen(function* () {
              calls += 1;
              if (calls === 1) {
                yield* Deferred.succeed(reading, undefined);
                yield* Deferred.await(release);
              }
              return makeSummary(input, { state: calls === 1 ? "closed" : "open" });
            }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([
              makeThread("closed", { pullRequests: [makeLink(2, { state: "closed" })] }),
            ]),
          );
          const key = { host: "github.com", repository: "owner/repository", number: 2 };
          yield* reactor.requestSync(key);
          yield* Deferred.await(reading);
          yield* reactor.requestSync(key);
          yield* Deferred.succeed(release, undefined);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).at(-1)?.snapshot.state, "open");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps polling open pull requests after the agent session settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("settled", {
              settledOverride: "settled",
              settledAt: "2026-08-21T00:00:00.000Z",
              pullRequests: [makeLink(5, { state: "open" })],
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          const firstCommands = yield* Ref.get(fixture.syncCommands);
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, firstCommands));

          yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 1);

          yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 3);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 2);
          assert.strictEqual(
            (yield* Ref.get(fixture.syncCommands)).at(-1)?.snapshot.syncedAt,
            "2026-08-28T12:02:00.000Z",
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("auto-links missing native stack layers and leaves dismissed ones alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stack: PullRequestStack = {
          id: "stack-1",
          number: 42,
          url: "https://github.com/owner/repository/stack/1",
          base: "main",
          layers: [
            { number: 41, headBranch: "layer-1", state: "merged" },
            { number: 42, headBranch: "layer-2", state: "merged" },
            { number: 43, headBranch: "layer-3", state: "open" },
          ],
        };
        let thread = makeThread("one", {
          pullRequests: [
            makeLink(42, { state: "open" }),
            makeLink(41, { state: "merged" }, { source: "stack-dismissed" }),
          ],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          summary: (input) =>
            Effect.succeed(makeSummary(input, { state: "merged", mergedAt: NOW })),
          stack: () => Effect.succeed(stack),
          onDispatch: (command) =>
            Effect.sync(() => {
              thread =
                command.type === "thread.pull-request.link"
                  ? { ...thread, pullRequests: [...thread.pullRequests, makeLink(command.number)] }
                  : applySync(makeSnapshot([thread]), [command]).threads[0]!;
              // Every projected event may wake settlement, including the terminal root update.
              assert.isNull(
                resolveAutoSettlementAt({
                  thread,
                  pullRequest: null,
                  now: NOW,
                  autoSettleAfterDays: null,
                  autoSettleOnMerge: true,
                }),
              );
            }),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          const syncCommands = yield* Ref.get(fixture.syncCommands);
          assert.deepStrictEqual(
            syncCommands.map((command) => [command.number, command.stack] as const),
            [[42, { kind: "native", ...stack }]],
          );
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.linkCommands)).map(({ commandId: _, ...rest }) => rest),
            [
              {
                type: "thread.pull-request.link",
                threadId: ThreadId.make("one"),
                host: "github.com",
                repository: "owner/repository",
                number: 43,
                url: "https://github.com/owner/repository/pull/43",
                source: "stack",
              },
            ],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps existing snapshots and continues when the host fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("failing", { pullRequests: [makeLink(7, { state: "open" })] }),
            makeThread("fine", { pullRequests: [makeLink(8)] }),
          ]),
          summary: (input) =>
            input.number === 7
              ? Effect.fail(
                  new PullRequestOperationError({ operation: "summary", detail: "host down" }),
                )
              : Effect.succeed(makeSummary(input)),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map((command) => command.number),
            [8],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
const supervisedTestLink = () => ({
  ...makeLink(42, null),
  supervision: {
    owner: "firstmate:00000000-0000-4000-8000-000000000001",
    environmentKey: "environment-a",
    lockSha: "a".repeat(40),
    headSha: "b".repeat(40),
    state: "watching" as const,
    baseRef: "main",
    headRef: "feature",
    resumes: 0,
    lastResumeKey: null,
    lastReason: null,
    expiresAt: "2999-01-01T00:00:00.000Z",
  },
});

it.effect("a copied database cannot acquire, wake or release the original environment's PR", () =>
  Effect.gen(function* () {
    for (const state of ["pending", "watching", "stopping", "blocked"] as const) {
      const link = supervisedTestLink();
      yield* supervisePrLink(
        { dispatch: () => Effect.die("must not dispatch") },
        makeThread("copied-owner"),
        makeProject(),
        { ...link, supervision: { ...link.supervision, state } },
        NOW,
        "different-environment",
        () => Effect.die("must not call adapter"),
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("pending enrollment is recovered before any automatic model turn", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const operations: string[] = [];
    const link = supervisedTestLink();
    yield* supervisePrLink(
      {
        dispatch: (command) => {
          commands.push(command);
          return Effect.succeed({ sequence: 1 });
        },
      },
      makeThread("owner"),
      makeProject(),
      { ...link, supervision: { ...link.supervision, state: "pending" } },
      NOW,
      "environment-a",
      (input) => {
        operations.push(input.operation);
        return Effect.succeed({
          schema: "firstmate-pr-supervision/v1" as const,
          enrolled: true,
          lockSha: "a".repeat(40),
          headSha: "b".repeat(40),
        });
      },
    );
    expect(operations).toEqual(["enroll"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ action: "enrolled" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("supervision resumes the linked original thread only after writer authorization", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const operations: string[] = [];
    yield* supervisePrLink(
      {
        dispatch: (command) => {
          commands.push(command);
          return Effect.succeed({ sequence: 1 });
        },
      },
      makeThread("original-owner"),
      makeProject(),
      supervisedTestLink(),
      NOW,
      "environment-a",
      (input) => {
        operations.push(input.operation);
        return Effect.succeed(
          input.operation === "enroll"
            ? {
                schema: "firstmate-pr-supervision/v1" as const,
                enrolled: true,
                lockSha: "a".repeat(40),
                headSha: "b".repeat(40),
              }
            : {
                schema: "firstmate-pr-supervision/v1" as const,
                state: "needs_work",
                writerAuthorized: true,
                headSha: "a".repeat(40),
                gateCheckId: 20,
              },
        );
      },
    );
    expect(operations).toEqual(["observe"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.pull-request.supervise",
      action: "wake",
      threadId: "original-owner",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a same-branch push advances the enrolled revision before any gate can wake the model",
  () =>
    Effect.gen(function* () {
      const commands: Array<OrchestrationCommand> = [];
      const observedInputs: Array<{ headSha?: string }> = [];
      yield* supervisePrLink(
        {
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: 1 });
          },
        },
        makeThread("owner"),
        makeProject(),
        supervisedTestLink(),
        NOW,
        "environment-a",
        (input) => {
          observedInputs.push(input);
          return Effect.succeed({
            schema: "firstmate-pr-supervision/v1" as const,
            state: "revision_changed",
            writerAuthorized: true,
            headSha: "c".repeat(40),
          });
        },
      );
      expect(observedInputs).toEqual([expect.objectContaining({ headSha: "b".repeat(40) })]);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        action: "revised",
        lockSha: "a".repeat(40),
        headSha: "c".repeat(40),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("supervision never calls an adapter while a user approval is pending", () =>
  Effect.gen(function* () {
    let called = false;
    yield* supervisePrLink(
      {
        dispatch: () => {
          throw new Error("must not dispatch");
        },
      },
      makeThread("owner", { hasPendingApprovals: true }),
      makeProject(),
      supervisedTestLink(),
      NOW,
      "environment-a",
      () => {
        called = true;
        return Effect.succeed({ schema: "firstmate-pr-supervision/v1" as const });
      },
    );
    expect(called).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reconciled gate IDs with identical evidence cannot spend another resume", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const link = supervisedTestLink();
    let lastResumeKey: string | null = null;
    for (const gateCheckId of [20, 21]) {
      yield* supervisePrLink(
        {
          dispatch: (command) => {
            commands.push(command);
            if (command.type === "thread.pull-request.supervise")
              lastResumeKey = command.resumeKey ?? null;
            return Effect.succeed({ sequence: 1 });
          },
        },
        makeThread("owner"),
        makeProject(),
        { ...link, supervision: { ...link.supervision, lastResumeKey } },
        NOW,
        "environment-a",
        (input) =>
          Effect.succeed(
            input.operation === "enroll"
              ? {
                  schema: "firstmate-pr-supervision/v1" as const,
                  enrolled: true,
                  lockSha: "a".repeat(40),
                  headSha: "b".repeat(40),
                }
              : {
                  schema: "firstmate-pr-supervision/v1" as const,
                  state: "needs_work",
                  writerAuthorized: true,
                  headSha: "a".repeat(40),
                  baseSha: "b".repeat(40),
                  reason: "Gate failed",
                  gateSummary: "Unit test failure",
                  gateCheckId,
                },
          ),
      );
    }
    expect(commands).toHaveLength(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("pending evidence and missing writer authority never wake a model", () =>
  Effect.gen(function* () {
    for (const receipt of [
      { state: "waiting", writerAuthorized: true, headSha: "a".repeat(40) },
      { state: "needs_work", writerAuthorized: false, headSha: "a".repeat(40) },
    ]) {
      const commands: Array<OrchestrationCommand> = [];
      yield* supervisePrLink(
        {
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: 1 });
          },
        },
        makeThread("owner"),
        makeProject(),
        supervisedTestLink(),
        NOW,
        "environment-a",
        (input) =>
          Effect.succeed(
            input.operation === "enroll"
              ? {
                  schema: "firstmate-pr-supervision/v1" as const,
                  enrolled: true,
                  lockSha: "a".repeat(40),
                  headSha: "b".repeat(40),
                }
              : { schema: "firstmate-pr-supervision/v1" as const, ...receipt },
          ),
      );
      expect(commands).toEqual([]);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("exhausted supervision releases ownership without another model call", () =>
  Effect.gen(function* () {
    const operations: string[] = [];
    const commands: Array<OrchestrationCommand> = [];
    const link = supervisedTestLink();
    link.supervision.resumes = 3;
    yield* supervisePrLink(
      {
        dispatch: (command) => {
          commands.push(command);
          return Effect.succeed({ sequence: 1 });
        },
      },
      makeThread("owner"),
      makeProject(),
      link,
      NOW,
      "environment-a",
      (input) => {
        operations.push(input.operation);
        return Effect.succeed({ schema: "firstmate-pr-supervision/v1" as const, released: true });
      },
    );
    expect(operations).toEqual(["release"]);
    expect(commands[0]).toMatchObject({
      action: "released",
      reason: "Three automatic resumptions exhausted.",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cleanup recovers a lost enrollment receipt without acquiring a new writer", () =>
  Effect.gen(function* () {
    const operations: string[] = [];
    const commands: Array<OrchestrationCommand> = [];
    const link = supervisedTestLink();
    const { lockSha: _lost, ...pending } = link.supervision;
    yield* supervisePrLink(
      {
        dispatch: (command) => {
          commands.push(command);
          return Effect.succeed({ sequence: 1 });
        },
      },
      makeThread("owner"),
      makeProject(),
      { ...link, supervision: { ...pending, state: "stopping" } },
      NOW,
      "environment-a",
      (input) => {
        operations.push(input.operation);
        if (input.operation === "inspect")
          return Effect.succeed({
            schema: "firstmate-pr-supervision/v1" as const,
            lockSha: "b".repeat(40),
          });
        expect(input.lockSha).toBe("b".repeat(40));
        return Effect.succeed({ schema: "firstmate-pr-supervision/v1" as const, released: true });
      },
    );
    expect(operations).toEqual(["inspect", "release"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ action: "released" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("missing writer acquisition proof blocks observation and resumption", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const { lockSha: _missing, ...state } = supervisedTestLink().supervision;
    yield* supervisePrLink(
      {
        dispatch: (command) => {
          commands.push(command);
          return Effect.succeed({ sequence: 1 });
        },
      },
      makeThread("owner"),
      makeProject(),
      { ...supervisedTestLink(), supervision: state },
      NOW,
      "environment-a",
      () => Effect.die("must not observe without acquisition proof"),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ action: "blocked" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("slow supervision does not hold up an explicit host refresh", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fixture = yield* makeHarness({
      snapshot: makeSnapshot([makeThread("refresh", { pullRequests: [makeLink(42)] })]),
      archivedSnapshot: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(makeSnapshot([])),
        ),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      yield* reactor.start();
      yield* Deferred.succeed(fixture.activation, undefined);
      yield* Deferred.await(started);
      yield* reactor.requestSync({
        host: "github.com",
        repository: "owner/repository",
        number: 42,
      });
      yield* reactor.drain;
      expect((yield* Ref.get(fixture.summaryCalls)).length).toBeGreaterThan(0);
      yield* Deferred.succeed(release, undefined);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.scoped),
);

it.effect("an archived supervised thread releases its exact writer without a model turn", () =>
  Effect.gen(function* () {
    const operations: string[] = [];
    const commands: Array<OrchestrationCommand> = [];
    yield* supervisePrLink(
      {
        dispatch: (command) => {
          commands.push(command);
          return Effect.succeed({ sequence: 1 });
        },
      },
      makeThread("archived", { archivedAt: NOW }),
      makeProject(),
      supervisedTestLink(),
      NOW,
      "environment-a",
      (input) => {
        operations.push(input.operation);
        expect(input.lockSha).toBe("a".repeat(40));
        return Effect.succeed({ schema: "firstmate-pr-supervision/v1" as const, released: true });
      },
    );
    expect(operations).toEqual(["release"]);
    expect(commands[0]).toMatchObject({ action: "released", reason: "Thread archived." });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a rejected release retains ownership until inspection proves this owner is absent", () =>
  Effect.gen(function* () {
    for (const remaining of ["b".repeat(40), null]) {
      const commands: Array<OrchestrationCommand> = [];
      const link = supervisedTestLink();
      yield* supervisePrLink(
        {
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: 1 });
          },
        },
        makeThread("owner"),
        makeProject(),
        { ...link, supervision: { ...link.supervision, state: "stopping" } },
        NOW,
        "environment-a",
        (input) =>
          Effect.succeed(
            input.operation === "release"
              ? { schema: "firstmate-pr-supervision/v1" as const, released: false }
              : { schema: "firstmate-pr-supervision/v1" as const, lockSha: remaining },
          ),
      );
      expect(commands).toHaveLength(remaining === null ? 1 : 0);
      if (remaining === null) expect(commands[0]).toMatchObject({ action: "released" });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
