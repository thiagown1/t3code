import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  cancelFirstMateDecision,
  createFirstMateTopic,
  openFirstMateDecision,
  resolveFirstMateDecision,
  type CancelFirstMateDecisionInput,
  type CreateFirstMateTopicInput,
  type OpenFirstMateDecisionInput,
  type ResolveFirstMateDecisionInput,
} from "../operations/commands.ts";

export type {
  CancelFirstMateDecisionInput,
  CreateFirstMateTopicInput,
  OpenFirstMateDecisionInput,
  ResolveFirstMateDecisionInput,
} from "../operations/commands.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const firstMateScheduler = createAtomCommandScheduler();
  return {
    createFirstMateTopic: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:firstmate:create-topic",
      execute: (input: CreateFirstMateTopicInput) => createFirstMateTopic(input),
      scheduler: firstMateScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.topicId]),
      },
    }),
    openFirstMateDecision: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:firstmate:open-decision",
      execute: (input: OpenFirstMateDecisionInput) => openFirstMateDecision(input),
      scheduler: firstMateScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.decisionId]),
      },
    }),
    resolveFirstMateDecision: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:firstmate:resolve-decision",
      execute: (input: ResolveFirstMateDecisionInput) => resolveFirstMateDecision(input),
      scheduler: firstMateScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.decisionId]),
      },
    }),
    cancelFirstMateDecision: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:firstmate:cancel-decision",
      execute: (input: CancelFirstMateDecisionInput) => cancelFirstMateDecision(input),
      scheduler: firstMateScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.decisionId]),
      },
    }),
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
  };
}
