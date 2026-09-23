import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadProviderHandoffRpcError,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ServerProvider,
  type ThreadProviderHandoffStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  runThreadProviderHandoff,
  type ThreadProviderHandoffCoordinatorServices,
} from "./ThreadProviderHandoffCoordinator.ts";

const threadId = ThreadId.make("thread-handoff-test");
const projectId = ProjectId.make("project-handoff-test");
const sourceId = ProviderInstanceId.make("codex-primary");
const targetId = ProviderInstanceId.make("claude-primary");
const now = "2026-09-22T20:00:00.000Z";
const turnId = TurnId.make("turn-handoff-test");
const target = {
  providerInstanceId: targetId,
  driver: "claudeAgent" as const,
  model: "claude-opus-4-6",
} as ThreadProviderHandoffStartInput["target"];
const input: ThreadProviderHandoffStartInput = { threadId, target };
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "C:\\workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
} as OrchestrationProjectShell;
const thread = {
  id: threadId,
  projectId,
  title: "Conversation",
  modelSelection: { instanceId: sourceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: {
    turnId,
    state: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    assistantMessageId: "message-2",
  },
  messages: [
    {
      id: "message-1",
      role: "user",
      text: "Keep this context",
      turnId,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "message-2",
      role: "assistant",
      text: "Ready",
      turnId,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  activities: [],
  proposedPlans: [],
  checkpoints: [],
  session: {
    threadId,
    status: "ready",
    providerName: "codex",
    providerInstanceId: sourceId,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
} as unknown as OrchestrationThread;

function harness(failContext = false) {
  const events: string[] = [];
  let state = "prepared";
  const sourceBinding = {
    threadId,
    provider: thread.session!.providerName,
    providerInstanceId: sourceId,
    resumeCursor: { source: "resume" },
  };
  const services = {
    snapshots: {
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 23 }),
      getThreadDetailSnapshot: () => Effect.succeed(Option.some({ snapshotSequence: 23, thread })),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    },
    turns: { getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()) },
    providers: {
      getProviders: Effect.succeed([
        {
          instanceId: targetId,
          driver: target.driver,
          enabled: true,
          installed: true,
          availability: "available",
          status: "ready",
          models: [{ slug: target.model }],
        } as unknown as ServerProvider,
      ]),
    },
    directory: { getBinding: () => Effect.succeed(Option.some(sourceBinding)) },
    store: {
      createPrepared: (item: unknown) =>
        Effect.sync(() => {
          events.push("prepared");
          return item;
        }),
      saveSourceBinding: () =>
        Effect.sync(() => {
          events.push("backup");
        }),
      transition: (item: { nextState: string }) =>
        Effect.sync(() => {
          state = item.nextState;
          events.push(state);
          return item;
        }),
    },
    providerService: {
      stageHandoffTarget: () =>
        Effect.sync(() => {
          events.push("stage");
          return {};
        }),
      sendStagedHandoffContext: () =>
        failContext
          ? Effect.fail(
              new ThreadProviderHandoffRpcError({ code: "target", detail: "target refused" }),
            )
          : Effect.sync(() => {
              events.push("context accepted");
              return {};
            }),
      commitStagedHandoffTarget: () =>
        Effect.sync(() => {
          events.push("bind target");
          return {
            threadId,
            provider: target.driver,
            providerInstanceId: targetId,
            runtimeMode: "full-access",
            model: target.model,
          };
        }),
      abortStagedHandoffTarget: () =>
        Effect.sync(() => {
          events.push("abort");
        }),
      finalizeStagedHandoffTarget: () =>
        Effect.sync(() => {
          events.push("finalize");
        }),
    },
    dispatch: (command: { type: string }) =>
      Effect.sync(() => {
        events.push(command.type);
        return {};
      }),
    nextCommandId: () => Effect.succeed(CommandId.make("command-handoff")),
    nowIso: Effect.succeed(now),
    newHandoffId: Effect.succeed("handoff-test"),
  } as unknown as ThreadProviderHandoffCoordinatorServices;
  return { services, events, getState: () => state };
}

it.effect("commits only after the target accepts context and the source backup is saved", () =>
  Effect.gen(function* () {
    const { services, events, getState } = harness();
    const result = yield* runThreadProviderHandoff(input, services);
    assert.equal(result.state, "committed");
    assert.equal(getState(), "committed");
    assert.isBelow(events.indexOf("context accepted"), events.indexOf("backup"));
    assert.isBelow(events.indexOf("backup"), events.indexOf("bind target"));
    assert.isBelow(events.indexOf("bind target"), events.indexOf("thread.meta.update"));
  }),
);

it.effect("leaves the source bound when the target rejects the context", () =>
  Effect.gen(function* () {
    const { services, events, getState } = harness(true);
    const failure = yield* Effect.flip(runThreadProviderHandoff(input, services));
    assert.equal("code" in failure ? failure.code : "other", "target");
    assert.equal(getState(), "failed");
    assert.include(events, "abort");
    assert.notInclude(events, "bind target");
    assert.notInclude(events, "thread.meta.update");
  }),
);
