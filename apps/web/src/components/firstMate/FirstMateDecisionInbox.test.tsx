import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FirstMateDecisionInbox } from "./FirstMateDecisionInbox";

const now = "2026-09-14T20:00:00.000Z";
const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const topicId = FirstMateTopicId.make("topic-1");

const project: EnvironmentProject = {
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
    topics: [
      {
        id: topicId,
        projectId,
        title: "Deploy workflow",
        summary: "Choose how to release.",
        stage: "completed",
        threadId: null,
        responsibleAgentId: "firstmate",
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
    ],
    decisions: [
      {
        id: FirstMateDecisionId.make("decision-1"),
        projectId,
        topicId,
        source: { kind: "firstmate", sourceId: "release" },
        question: "Deploy behind a feature flag?",
        options: [
          { id: "flag", label: "Use flag", description: "Keep activation separate." },
          { id: "direct", label: "Deploy directly", description: "Release immediately." },
        ],
        recommendedOptionId: "flag",
        selectedOptionId: null,
        blocking: true,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      },
    ],
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

describe("FirstMateDecisionInbox", () => {
  it("renders the global count, impact, recommendation, and blocking state", () => {
    const markup = renderToStaticMarkup(
      <FirstMateDecisionInbox
        projects={[project]}
        threads={[]}
        scopedProjectKeys={null}
        onResolveDecision={async () => true}
        onCancelDecision={async () => true}
        onOpenThread={() => {}}
      />,
    );

    expect(markup).toContain("Decisions");
    expect(markup).toContain("Deploy behind a feature flag?");
    expect(markup).toContain("Keep activation separate.");
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Blocking");
    expect(markup).toContain("Cancel");
  });

  it("stays out of the sidebar when nothing is pending", () => {
    const markup = renderToStaticMarkup(
      <FirstMateDecisionInbox
        projects={[{ ...project, firstMate: { ...project.firstMate!, decisions: [] } }]}
        threads={[]}
        scopedProjectKeys={null}
        onResolveDecision={async () => true}
        onCancelDecision={async () => true}
        onOpenThread={() => {}}
      />,
    );

    expect(markup).toBe("");
  });
});
