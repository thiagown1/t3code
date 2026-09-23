import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, FirstMateTopicId, ProjectId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FirstMateRouteConfirmation } from "./FirstMateRouteConfirmation";

const now = "2026-09-14T20:00:00.000Z";
const projectId = ProjectId.make("project-1");
const topicId = FirstMateTopicId.make("routing");
const project: EnvironmentProject = {
  environmentId: EnvironmentId.make("local"),
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
    supervisorThreadId: ThreadId.make("supervisor"),
    selectedTopicId: null,
    topics: [
      {
        id: topicId,
        projectId,
        title: "Route supervisor messages",
        summary: "Keep work moving.",
        stage: "implementation",
        threadId: ThreadId.make("worker"),
        responsibleAgentId: "firstmate",
        latestRoundSummary: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
    ],
    decisions: [],
    routingReceipts: [],
    routingEvaluationMode: "off",
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

describe("FirstMateRouteConfirmation", () => {
  it("renders a compact topic choice when routing is ambiguous", () => {
    const markup = renderToStaticMarkup(
      <FirstMateRouteConfirmation
        project={project}
        request={{
          reason: "no-selected-topic",
          candidateTopicIds: [topicId],
          message: "Continue.",
        }}
        confirmingTopicId={null}
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("Where should this message go?");
    expect(markup).toContain("Route supervisor messages");
    expect(markup).toContain('aria-label="FirstMate routing confirmation"');
  });

  it("keeps unsupported context fail-closed", () => {
    const markup = renderToStaticMarkup(
      <FirstMateRouteConfirmation
        project={project}
        request={{
          reason: "composer-context-not-supported",
          candidateTopicIds: [topicId],
          message: "Inspect the image.",
        }}
        confirmingTopicId={null}
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("Attachments remain in this draft.");
    expect(markup).toContain("disabled");
  });
});
