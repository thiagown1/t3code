import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  FirstMateDecisionId,
  FirstMateTopicId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type FirstMateDecision,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFirstMatePanelModel,
  firstMateListedThreadKeys,
  firstMatePanelPullRequests,
  linkableSupervisorThread,
} from "./FirstMateTopicsPanel.logic";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const topicId = FirstMateTopicId.make("topic-1");
const now = "2026-09-14T20:00:00.000Z";

function pullRequest(
  number: number,
  overrides: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "agent",
    linkedAt: now,
    stack: null,
    snapshot: {
      state: "open",
      title: `PR ${number}`,
      headBranch: `feature-${number}`,
      headSha: `abc123${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: now,
      syncedAt: now,
      checksState: "pending",
      checks: [{ name: "CI", status: "pending", description: null, url: null }],
      ...overrides,
    },
  };
}

function project(firstMate: EnvironmentProject["firstMate"]): EnvironmentProject {
  return {
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
    ...(firstMate === undefined ? {} : { firstMate }),
    createdAt: now,
    updatedAt: now,
  };
}

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
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
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const workspace: NonNullable<EnvironmentProject["firstMate"]> = {
  projectId,
  supervisorThreadId: null,
  selectedTopicId: null,
  topics: [
    {
      id: topicId,
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
  decisions: [],
  routingReceipts: [],
  routingEvaluationMode: "off",
  updatedAt: now,
};

describe("FirstMate topics panel model", () => {
  it("distinguishes unavailable environments from an empty workspace", () => {
    expect(
      buildFirstMatePanelModel({
        projects: [project(undefined)],
        threads: [],
        scopedProjectKeys: null,
      }).availability,
    ).toBe("unavailable");
    expect(
      buildFirstMatePanelModel({
        projects: [project(null)],
        threads: [],
        scopedProjectKeys: null,
      }).availability,
    ).toBe("empty");
  });

  it("names the supervisor thread, and reports a link that outlived its thread", () => {
    const supervisorThreadId = ThreadId.make("thread-supervisor");
    const linked = buildFirstMatePanelModel({
      projects: [project({ ...workspace, supervisorThreadId })],
      threads: [thread(), thread({ id: supervisorThreadId, title: "Planning" })],
      scopedProjectKeys: null,
    });
    expect(linked.supervisors).toMatchObject([
      { projectId, threadId: supervisorThreadId, threadTitle: "Planning" },
    ]);

    const stale = buildFirstMatePanelModel({
      projects: [project({ ...workspace, supervisorThreadId })],
      threads: [thread()],
      scopedProjectKeys: null,
    });
    expect(stale.supervisors).toMatchObject([{ threadId: supervisorThreadId, threadTitle: null }]);

    expect(
      buildFirstMatePanelModel({
        projects: [project(workspace)],
        threads: [thread()],
        scopedProjectKeys: null,
      }).supervisors,
    ).toEqual([]);
  });

  it("derives waiting deploy from the linked thread without persisting another status", () => {
    const model = buildFirstMatePanelModel({
      projects: [project({ ...workspace, selectedTopicId: topicId })],
      threads: [thread({ deliveryStatus: "waiting-deploy" })],
      scopedProjectKeys: null,
    });

    expect(model.items[0]).toMatchObject({
      status: "waiting-deploy",
      selected: true,
      threadId,
      pendingDecisionCount: 0,
    });
    expect(model.routingEvaluation).toEqual({
      environmentId,
      projectId,
      mode: "off",
    });
  });

  it("prioritizes a pending FirstMate decision over delivery status", () => {
    const model = buildFirstMatePanelModel({
      projects: [
        project({
          ...workspace,
          decisions: [
            {
              id: FirstMateDecisionId.make("decision-1"),
              projectId,
              topicId,
              source: { kind: "firstmate", sourceId: "routing" },
              question: "Deploy now?",
              options: [],
              recommendedOptionId: null,
              selectedOptionId: null,
              blocking: true,
              status: "pending",
              createdAt: now,
              updatedAt: now,
              resolvedAt: null,
            },
          ],
        }),
      ],
      threads: [thread({ deliveryStatus: "waiting-deploy" })],
      scopedProjectKeys: null,
    });

    expect(model.items[0]).toMatchObject({ status: "waiting-user", pendingDecisionCount: 1 });
  });

  it("filters topics by the active project scope", () => {
    const model = buildFirstMatePanelModel({
      projects: [project(workspace)],
      threads: [thread()],
      scopedProjectKeys: new Set([`${environmentId}:another-project`]),
    });

    expect(model).toMatchObject({ availability: "unavailable", projectCount: 0, items: [] });
  });

  it("derives the topic from every linked PR and exposes the exact check snapshot", () => {
    const model = buildFirstMatePanelModel({
      projects: [project(workspace)],
      threads: [
        thread({
          deliveryStatus: "waiting-ci",
          pullRequests: [
            pullRequest(41, {
              state: "merged",
              mergedAt: now,
              checksState: "passing",
              checks: [{ name: "CI", status: "success", description: null, url: null }],
            }),
            pullRequest(42, {
              checks: [
                { name: "CI", status: "success", description: null, url: null },
                {
                  name: "Review",
                  status: "action-required",
                  description: "Approval needed",
                  url: null,
                },
              ],
            }),
          ],
        }),
      ],
      scopedProjectKeys: null,
      nowMs: Date.parse(now),
    });

    expect(model.items[0]?.status).toBe("blocked");
    expect(model.items[0]?.pullRequests).toMatchObject([
      { number: 41, headSha: "abc12341", status: "merged", checks: { success: 1 } },
      {
        number: 42,
        headSha: "abc12342",
        status: "action-required",
        checks: { success: 1, "action-required": 1 },
      },
    ]);
  });

  it("moves from waiting CI to ready to merge only for a fresh green head", () => {
    const pending = buildFirstMatePanelModel({
      projects: [project(workspace)],
      threads: [thread({ pullRequests: [pullRequest(42)] })],
      scopedProjectKeys: null,
      nowMs: Date.parse(now),
    });
    const passing = buildFirstMatePanelModel({
      projects: [project(workspace)],
      threads: [
        thread({
          deliveryStatus: "waiting-ci",
          pullRequests: [
            pullRequest(42, {
              checksState: "passing",
              checks: [{ name: "CI", status: "success", description: null, url: null }],
            }),
          ],
        }),
      ],
      scopedProjectKeys: null,
      nowMs: Date.parse(now),
    });

    expect(pending.items[0]?.status).toBe("waiting-ci");
    expect(passing.items[0]?.status).toBe("ready-to-merge");
  });

  it("fails closed when an open PR snapshot is stale or only inconclusive checks remain", () => {
    const stale = firstMatePanelPullRequests(
      [pullRequest(42)],
      Date.parse(now) + 3 * 60 * 1_000 + 1,
    );
    const inconclusive = firstMatePanelPullRequests(
      [
        pullRequest(43, {
          checksState: null,
          checks: [{ name: "CI", status: "cancelled", description: null, url: null }],
        }),
      ],
      Date.parse(now),
    );

    expect(stale[0]?.status).toBe("stale");
    expect(inconclusive[0]?.status).toBe("inconclusive");
  });

  it("asks the operator to choose deploy or archive after every PR merges", () => {
    const merged = pullRequest(42, {
      state: "merged",
      mergedAt: now,
      checksState: "passing",
      checks: [{ name: "CI", status: "success", description: null, url: null }],
    });
    const awaitingChoice = buildFirstMatePanelModel({
      projects: [project(workspace)],
      threads: [thread({ pullRequests: [merged] })],
      scopedProjectKeys: null,
      nowMs: Date.parse(now),
    });
    const waitingDeploy = buildFirstMatePanelModel({
      projects: [project(workspace)],
      threads: [thread({ pullRequests: [merged], deliveryStatus: "waiting-deploy" })],
      scopedProjectKeys: null,
      nowMs: Date.parse(now),
    });

    expect(awaitingChoice.items[0]).toMatchObject({
      status: "waiting-user",
      postMergeActionRequired: true,
    });
    expect(waitingDeploy.items[0]).toMatchObject({
      status: "waiting-deploy",
      postMergeActionRequired: false,
    });
  });
});

describe("a thread the user is already talking to", () => {
  const running = {
    threadId,
    status: "running" as const,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: TurnId.make("turn-2"),
    lastError: null,
    updatedAt: now,
  };
  const implementing = {
    ...workspace,
    topics: workspace.topics.map((topic) => ({
      ...topic,
      stage: "implementation" as const,
      completedAt: null,
    })),
  };
  const turnReview = (overrides: Partial<FirstMateDecision> = {}): FirstMateDecision => ({
    id: FirstMateDecisionId.make("turn-review:thread-1:turn-1"),
    projectId,
    topicId,
    source: { kind: "turn-review", threadId, turnId: TurnId.make("turn-1") },
    question: "Should I also migrate the old rows?",
    options: [],
    recommendedOptionId: null,
    selectedOptionId: null,
    blocking: true,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    ...overrides,
  });

  // Reported: the user answered in the thread, the thread was working, and the
  // topic still said "Waiting for you" because the review card of the previous
  // turn stayed pending until the new turn ended.
  it("does not wait on a turn-review card once the thread runs again", () => {
    const projects = [project({ ...implementing, decisions: [turnReview()] })];
    const idle = buildFirstMatePanelModel({
      projects,
      threads: [thread()],
      scopedProjectKeys: null,
    });
    const answered = buildFirstMatePanelModel({
      projects,
      threads: [thread({ session: running })],
      scopedProjectKeys: null,
    });

    expect(idle.items[0]).toMatchObject({ status: "waiting-user", pendingDecisionCount: 1 });
    expect(answered.items[0]).toMatchObject({ status: "implementing", pendingDecisionCount: 0 });
  });

  it("still waits on a provider request raised while the thread runs", () => {
    const model = buildFirstMatePanelModel({
      projects: [project(implementing)],
      threads: [thread({ session: running, hasPendingApprovals: true })],
      scopedProjectKeys: null,
    });

    expect(model.items[0]?.status).toBe("waiting-user");
  });

  // Reported: a topic whose PRs had all merged said "Waiting for you" while its
  // thread was visibly working on the follow-up.
  it("keeps PR state per PR but never turns a running thread into waiting or blocked", () => {
    const merged = pullRequest(21, {
      state: "merged",
      mergedAt: now,
      checksState: "passing",
      checks: [{ name: "CI", status: "success", description: null, url: null }],
    });
    const actionRequired = pullRequest(22, {
      checks: [{ name: "Review", status: "action-required", description: null, url: null }],
    });
    const build = (pullRequests: ThreadPullRequestLink[], session: typeof running | null) =>
      buildFirstMatePanelModel({
        projects: [project(implementing)],
        threads: [thread({ pullRequests, session })],
        scopedProjectKeys: null,
        nowMs: Date.parse(now),
      }).items[0];

    expect(build([merged], null)?.status).toBe("waiting-user");
    expect(build([merged], running)?.status).toBe("implementing");
    expect(build([actionRequired], null)?.status).toBe("blocked");
    expect(build([actionRequired], running)).toMatchObject({
      status: "implementing",
      pullRequests: [{ number: 22, status: "action-required" }],
    });
  });
});

describe("firstMateListedThreadKeys", () => {
  const supervisorThreadId = ThreadId.make("thread-supervisor");
  const undelegated = {
    ...workspace.topics[0]!,
    id: FirstMateTopicId.make("topic-2"),
    threadId: null,
  };

  it("lists the supervisor chat and every delegated topic thread, scoped to the project", () => {
    const projects = [
      project({ ...workspace, supervisorThreadId, topics: [...workspace.topics, undelegated] }),
    ];

    expect([...firstMateListedThreadKeys(projects, null)].toSorted()).toEqual([
      `${environmentId}:${threadId}`,
      `${environmentId}:${supervisorThreadId}`,
    ]);
    expect(
      firstMateListedThreadKeys(projects, new Set([`${environmentId}:another-project`])).size,
    ).toBe(0);
    expect(firstMateListedThreadKeys([project(undefined)], null).size).toBe(0);
  });
});

describe("linkableSupervisorThread", () => {
  // Reported from a real install: the panel named a command the user had no way
  // to run, so FirstMate stayed unreachable.
  const openThread = {
    environmentId,
    projectId,
    threadId,
    threadTitle: "Planning",
  };

  it("offers the open thread when its project has a FirstMate workspace", () => {
    expect(
      linkableSupervisorThread({
        projects: [project(null)],
        activeThread: openThread,
        availability: "empty",
      }),
    ).toEqual(openThread);
  });

  it("offers nothing on a draft, where there is no thread to link", () => {
    expect(
      linkableSupervisorThread({
        projects: [project(null)],
        activeThread: undefined,
        availability: "empty",
      }),
    ).toBeNull();
  });

  it("offers nothing when the server has no FirstMate workspace to link into", () => {
    expect(
      linkableSupervisorThread({
        projects: [project(undefined)],
        activeThread: openThread,
        availability: "unavailable",
      }),
    ).toBeNull();
  });

  it("offers nothing for a thread belonging to another project", () => {
    expect(
      linkableSupervisorThread({
        projects: [project(null)],
        activeThread: { ...openThread, projectId: ProjectId.make("project-2") },
        availability: "empty",
      }),
    ).toBeNull();
  });
});
