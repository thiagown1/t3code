import { ORCHESTRATION_WS_METHODS, type ThreadCleanupPreview } from "@t3tools/contracts";
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
  handoffThread,
  createFirstMateTopic,
  linkFirstMateSupervisor,
  openFirstMateDecision,
  recordFirstMateRouting,
  setFirstMateRoutingEvaluationMode,
  resolveFirstMateDecision,
  selectFirstMateTopic,
  type CancelFirstMateDecisionInput,
  type HandoffThreadInput,
  type CreateFirstMateTopicInput,
  type LinkFirstMateSupervisorInput,
  type OpenFirstMateDecisionInput,
  type RecordFirstMateRoutingInput,
  type SetFirstMateRoutingEvaluationModeInput,
  type ResolveFirstMateDecisionInput,
  type SelectFirstMateTopicInput,
} from "../operations/commands.ts";

export type {
  CancelFirstMateDecisionInput,
  HandoffThreadInput,
  CreateFirstMateTopicInput,
  LinkFirstMateSupervisorInput,
  OpenFirstMateDecisionInput,
  RecordFirstMateRoutingInput,
  SetFirstMateRoutingEvaluationModeInput,
  ResolveFirstMateDecisionInput,
  SelectFirstMateTopicInput,
} from "../operations/commands.ts";

function providerLabel(preview: ThreadCleanupPreview): string | null {
  if (preview.provider.status === "not-linked") return null;
  switch (String(preview.provider.provider)) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
    case "antigravity":
      return "Antigravity";
    default:
      return String(preview.provider.provider);
  }
}

export function threadCleanupConfirmationMessage(
  preview: ThreadCleanupPreview | null,
  input: { readonly action: "archive" | "tombstone"; readonly title: string },
): string {
  if (input.action === "archive") {
    const providerOutcome =
      preview === null
        ? "This older server cannot preview provider cleanup. The provider-side outcome is unknown before archiving; check the archive receipt if the server provides one."
        : preview.provider.status === "not-linked"
          ? "No provider conversation is linked."
          : preview.provider.capabilities.archive === "supported"
            ? `After the local archive, T3 will attempt to archive the ${providerLabel(preview)} provider conversation. Its provider transcript is preserved, and the actual outcome is recorded in the archive receipt.`
            : preview.provider.capabilities.archive === "unavailable"
              ? `T3 cannot currently confirm whether the ${providerLabel(preview)} provider conversation can be archived. The archive receipt will record the actual provider-side outcome.`
              : `The ${providerLabel(preview)} provider conversation and transcript stay unchanged because remote archiving is unsupported.`;
    return [
      `Archive thread "${input.title}"?`,
      "T3 will hide the thread. Conversation history, terminal history, attachments, and the audit log stay available.",
      providerOutcome,
    ].join("\n\n");
  }

  const providerOutcome =
    preview === null
      ? "This older server cannot preview provider cleanup. This action does not request deletion of a provider conversation."
      : preview.provider.status === "not-linked"
        ? "No provider conversation is linked."
        : `The ${providerLabel(preview)} provider conversation and transcript stay unchanged.`;
  return [
    `Remove thread "${input.title}" from T3?`,
    "T3 will remove the thread from your lists and delete its terminal history and stored attachments. Conversation records remain in the audit log.",
    providerOutcome,
    "This cannot be undone in T3.",
  ].join("\n\n");
}

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const firstMateScheduler = createAtomCommandScheduler();
  return {
    handoffThread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:provider-handoff",
      execute: (input: HandoffThreadInput) => handoffThread(input),
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
    linkFirstMateSupervisor: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:firstmate:link-supervisor",
      execute: (input: LinkFirstMateSupervisorInput) => linkFirstMateSupervisor(input),
      scheduler: firstMateScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
    }),
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
    selectFirstMateTopic: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:firstmate:select-topic",
      execute: (input: SelectFirstMateTopicInput) => selectFirstMateTopic(input),
      scheduler: firstMateScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
    }),
    recordFirstMateRouting: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:firstmate:record-routing",
      execute: (input: RecordFirstMateRoutingInput) => recordFirstMateRouting(input),
      scheduler: firstMateScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.messageId]),
      },
    }),
    setFirstMateRoutingEvaluationMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:firstmate:set-routing-evaluation-mode",
      execute: (input: SetFirstMateRoutingEvaluationModeInput) =>
        setFirstMateRoutingEvaluationMode(input),
      scheduler: firstMateScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
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
    threadCleanupPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-cleanup-preview",
      tag: ORCHESTRATION_WS_METHODS.previewThreadCleanup,
      staleTimeMs: 0,
    }),
  };
}
