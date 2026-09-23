import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FirstMateTopicsPanel } from "./FirstMateTopicsPanel";

const now = "2026-09-14T20:00:00.000Z";
const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

const baseProject: EnvironmentProject = {
  environmentId,
  id: projectId,
  title: "T3 Code",
  workspaceRoot: "/tmp/t3code",
  repositoryIdentity: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  firstMate: {
    projectId,
    supervisorThreadId: null,
    selectedTopicId: null,
    topics: [],
    decisions: [],
    routingReceipts: [],
    routingEvaluationMode: "off",
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

const linkedThread: EnvironmentThreadShell = {
  environmentId,
  id: threadId,
  projectId,
  title: "Implement FirstMate",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deliveryStatus: "waiting-deploy",
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

describe("FirstMateTopicsPanel", () => {
  it("renders the empty workspace state", () => {
    const markup = renderToStaticMarkup(
      <FirstMateTopicsPanel
        projects={[baseProject]}
        threads={[]}
        scopedProjectKeys={null}
        onUnlinkSupervisor={async () => true}
        onSelectTopic={async () => true}
        onSetRoutingEvaluationMode={async () => true}
        onSetWaitingDeploy={async () => true}
        onArchiveThread={async () => true}
        onOpenThread={() => {}}
        onOpenFirstMate={async () => true}
      />,
    );

    expect(markup).toContain("No topics yet");
    expect(markup).toContain('aria-expanded="true"');
  });

  it("renders durable topic details and the derived deploy gate", () => {
    const markup = renderToStaticMarkup(
      <FirstMateTopicsPanel
        projects={[
          {
            ...baseProject,
            firstMate: {
              ...baseProject.firstMate!,
              selectedTopicId: FirstMateTopicId.make("topic-1"),
              topics: [
                {
                  id: FirstMateTopicId.make("topic-1"),
                  projectId,
                  title: "FirstMate panel",
                  summary: "Show durable topics in place.",
                  stage: "completed",
                  threadId,
                  responsibleAgentId: "firstmate",
                  latestRoundSummary: null,
                  createdAt: now,
                  updatedAt: now,
                  completedAt: now,
                },
              ],
            },
          },
        ]}
        threads={[linkedThread]}
        scopedProjectKeys={null}
        onUnlinkSupervisor={async () => true}
        onSelectTopic={async () => true}
        onSetRoutingEvaluationMode={async () => true}
        onSetWaitingDeploy={async () => true}
        onArchiveThread={async () => true}
        onOpenThread={() => {}}
        onOpenFirstMate={async () => true}
      />,
    );

    expect(markup).toContain("FirstMate panel");
    expect(markup).toContain("Show durable topics in place.");
    expect(markup).toContain("Waiting to deploy");
    expect(markup).toContain("firstmate");
    expect(markup).toContain("FirstMate panel is the active topic");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Automatic routing evaluation: Off");
  });

  it("shows every linked PR with its exact head and check readiness", () => {
    const markup = renderToStaticMarkup(
      <FirstMateTopicsPanel
        projects={[
          {
            ...baseProject,
            firstMate: {
              ...baseProject.firstMate!,
              topics: [
                {
                  id: FirstMateTopicId.make("topic-1"),
                  projectId,
                  title: "Release task",
                  summary: "Track both repositories.",
                  stage: "testing",
                  threadId,
                  responsibleAgentId: "firstmate",
                  latestRoundSummary: null,
                  createdAt: now,
                  updatedAt: now,
                  completedAt: null,
                },
              ],
            },
          },
        ]}
        threads={[
          {
            ...linkedThread,
            deliveryStatus: null,
            pullRequests: [
              {
                host: "github.com",
                repository: "acme/web",
                number: 12,
                url: "https://github.com/acme/web/pull/12",
                source: "agent",
                linkedAt: now,
                stack: null,
                snapshot: {
                  state: "open",
                  title: "Ship UI",
                  headBranch: "feature/ui",
                  headSha: "abcdef1234567890",
                  baseBranch: "main",
                  isDraft: false,
                  updatedAt: now,
                  syncedAt: new Date().toISOString(),
                  checksState: "passing",
                  checks: [{ name: "CI", status: "success", description: null, url: null }],
                },
              },
            ],
          },
        ]}
        scopedProjectKeys={null}
        onUnlinkSupervisor={async () => true}
        onSelectTopic={async () => true}
        onSetRoutingEvaluationMode={async () => true}
        onSetWaitingDeploy={async () => true}
        onArchiveThread={async () => true}
        onOpenThread={() => {}}
        onOpenFirstMate={async () => true}
      />,
    );

    expect(markup).toContain("#12");
    expect(markup).toContain("abcdef1");
    expect(markup).toContain("Ready to merge");
    expect(markup).toContain("acme/web#12 at abcdef1234567890");
  });

  it("offers explicit deploy or archive choices after every linked PR merges", () => {
    const markup = renderToStaticMarkup(
      <FirstMateTopicsPanel
        projects={[
          {
            ...baseProject,
            firstMate: {
              ...baseProject.firstMate!,
              topics: [
                {
                  id: FirstMateTopicId.make("topic-1"),
                  projectId,
                  title: "Release task",
                  summary: "Choose the post-merge step.",
                  stage: "testing",
                  threadId,
                  responsibleAgentId: "firstmate",
                  latestRoundSummary: null,
                  createdAt: now,
                  updatedAt: now,
                  completedAt: null,
                },
              ],
            },
          },
        ]}
        threads={[
          {
            ...linkedThread,
            deliveryStatus: null,
            pullRequests: [
              {
                host: "github.com",
                repository: "acme/web",
                number: 12,
                url: "https://github.com/acme/web/pull/12",
                source: "agent",
                linkedAt: now,
                stack: null,
                snapshot: {
                  state: "merged",
                  title: "Ship UI",
                  headBranch: "feature/ui",
                  headSha: "abcdef1234567890",
                  baseBranch: "main",
                  isDraft: false,
                  updatedAt: now,
                  syncedAt: now,
                  mergedAt: now,
                  checksState: "passing",
                  checks: [{ name: "CI", status: "success", description: null, url: null }],
                },
              },
            ],
          },
        ]}
        scopedProjectKeys={null}
        onUnlinkSupervisor={async () => true}
        onSelectTopic={async () => true}
        onSetRoutingEvaluationMode={async () => true}
        onSetWaitingDeploy={async () => true}
        onArchiveThread={async () => true}
        onOpenThread={() => {}}
        onOpenFirstMate={async () => true}
      />,
    );

    expect(markup).toContain("Waiting for you");
    expect(markup).toContain('aria-label="Mark Release task as waiting to deploy"');
    expect(markup).toContain('aria-label="Archive Release task"');
  });
});
