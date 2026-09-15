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
    topics: [],
    decisions: [],
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
        onOpenThread={() => {}}
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
              topics: [
                {
                  id: FirstMateTopicId.make("topic-1"),
                  projectId,
                  title: "FirstMate panel",
                  summary: "Show durable topics in place.",
                  stage: "completed",
                  threadId,
                  responsibleAgentId: "firstmate",
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
        onOpenThread={() => {}}
      />,
    );

    expect(markup).toContain("FirstMate panel");
    expect(markup).toContain("Show durable topics in place.");
    expect(markup).toContain("Waiting to deploy");
    expect(markup).toContain("firstmate");
  });
});
