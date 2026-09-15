import {
  FirstMateTopicId,
  ProjectId,
  ThreadId,
  type FirstMateTopic,
  type FirstMateWorkspaceState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { evaluateFirstMateAutomaticRouting, routeFirstMateMessage } from "./firstMate.ts";

const now = "2026-09-15T02:00:00.000Z";
const projectId = ProjectId.make("routing-evaluation-project");
const supervisorThreadId = ThreadId.make("supervisor-thread");

const topicIds = {
  machines: FirstMateTopicId.make("machines"),
  ci: FirstMateTopicId.make("ci"),
  deploy: FirstMateTopicId.make("deploy"),
  firebase: FirstMateTopicId.make("firebase"),
  prImages: FirstMateTopicId.make("pr-images"),
} as const;

function topic(input: {
  readonly id: FirstMateTopicId;
  readonly title: string;
  readonly summary: string;
  readonly threadId?: ThreadId | null;
}): FirstMateTopic {
  return {
    id: input.id,
    projectId,
    title: input.title,
    summary: input.summary,
    stage: "implementation",
    threadId: input.threadId === undefined ? ThreadId.make(`worker-${input.id}`) : input.threadId,
    responsibleAgentId: "firstmate",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

const topics: ReadonlyArray<FirstMateTopic> = [
  topic({
    id: topicIds.machines,
    title: "CPU memória e storage",
    summary: "Saúde das máquinas e servidores conectados.",
  }),
  topic({
    id: topicIds.ci,
    title: "CI checks",
    summary: "GitHub Actions, pipeline, testes, failures e falhas.",
  }),
  topic({
    id: topicIds.deploy,
    title: "Deploy em produção",
    summary: "Release, rollout, feature flag e ativação.",
  }),
  topic({
    id: topicIds.firebase,
    title: "Firebase e Firestore",
    summary: "Consultas de logs, autenticação e credenciais.",
  }),
  topic({
    id: topicIds.prImages,
    title: "Imagem do pull request",
    summary: "Load screenshots and images from the PR description ou descrição.",
  }),
];

function workspace(overrides: Partial<FirstMateWorkspaceState> = {}): FirstMateWorkspaceState {
  return {
    projectId,
    supervisorThreadId,
    selectedTopicId: topicIds.machines,
    topics,
    decisions: [],
    routingReceipts: [],
    routingEvaluationMode: "shadow",
    updatedAt: now,
    ...overrides,
  };
}

describe("FirstMate shadow routing evaluation scenarios", () => {
  it("classifies a labelled bilingual smoke dataset and abstains on semantic-only wording", () => {
    const scenarios = [
      {
        message: "A memória e o storage do servidor estão no limite.",
        expected: topicIds.machines,
      },
      {
        message: "Os checks do GitHub Actions falharam novamente.",
        expected: topicIds.ci,
      },
      {
        message: "Vamos fazer o deploy atrás de uma feature flag.",
        expected: topicIds.deploy,
      },
      {
        message: "Consultar os logs do Firebase no Firestore.",
        expected: topicIds.firebase,
      },
      {
        message: "The image from the pull request description is not loading.",
        expected: topicIds.prImages,
      },
      {
        message: "A esteira ficou vermelha.",
        expected: null,
      },
    ] as const;

    const results = scenarios.map((scenario) => ({
      ...scenario,
      evaluation: evaluateFirstMateAutomaticRouting(
        workspace(),
        scenario.message,
        scenario.expected ?? topicIds.ci,
      ),
    }));

    for (const result of results) {
      expect(result.evaluation?.candidateTopicId).toBe(result.expected);
    }
    const suggestions = results.filter((result) => result.evaluation?.candidateTopicId !== null);
    const correct = suggestions.filter(
      (result) => result.evaluation?.candidateTopicId === result.expected,
    );
    expect({
      coverage: suggestions.length / results.length,
      accuracyWhenSuggested: correct.length / suggestions.length,
    }).toEqual({ coverage: 5 / 6, accuracyWhenSuggested: 1 });
  });

  it("normalizes accents before scoring", () => {
    expect(
      evaluateFirstMateAutomaticRouting(
        workspace(),
        "MEMORIA do servidor acima do limite",
        topicIds.machines,
      ),
    ).toMatchObject({ candidateTopicId: topicIds.machines, outcome: "matched" });
  });

  it("abstains when the best score is tied", () => {
    const tiedTopics = [
      topic({
        id: FirstMateTopicId.make("production-logs"),
        title: "Production logs",
        summary: "Runtime investigation.",
      }),
      topic({
        id: FirstMateTopicId.make("firebase-logs"),
        title: "Firebase logs",
        summary: "Data investigation.",
      }),
    ];

    expect(
      evaluateFirstMateAutomaticRouting(
        workspace({ topics: tiedTopics }),
        "Inspect logs",
        tiedTopics[0]!.id,
      ),
    ).toEqual({ candidateTopicId: null, score: 3, outcome: "no-candidate" });
  });

  it("ignores undelegated topics and a topic linked back to the supervisor", () => {
    const invalidTopics = [
      topic({
        id: FirstMateTopicId.make("undelegated-ci"),
        title: "GitHub Actions checks failures",
        summary: "CI pipeline.",
        threadId: null,
      }),
      topic({
        id: FirstMateTopicId.make("recursive-ci"),
        title: "GitHub Actions checks failures",
        summary: "CI pipeline.",
        threadId: supervisorThreadId,
      }),
      topics.find((entry) => entry.id === topicIds.ci)!,
    ];

    expect(
      evaluateFirstMateAutomaticRouting(
        workspace({ topics: invalidTopics }),
        "GitHub Actions checks failures",
        topicIds.ci,
      ),
    ).toMatchObject({ candidateTopicId: topicIds.ci, outcome: "matched" });
  });

  it("strips explicit topic mentions so they cannot inflate the shadow score", () => {
    expect(
      evaluateFirstMateAutomaticRouting(
        workspace(),
        "@topic:deploy investigar CPU e memória",
        topicIds.machines,
      ),
    ).toMatchObject({ candidateTopicId: topicIds.machines, outcome: "matched" });
  });

  it("reports disagreement without changing the selected deterministic route", () => {
    const state = workspace({ selectedTopicId: topicIds.machines });
    const message = "Re-run the CI checks and inspect GitHub Actions failures.";

    expect(evaluateFirstMateAutomaticRouting(state, message, topicIds.machines)).toMatchObject({
      candidateTopicId: topicIds.ci,
      outcome: "different",
    });
    expect(routeFirstMateMessage(state, message)).toMatchObject({
      status: "routed",
      topicId: topicIds.machines,
      reason: "selected-topic",
    });
  });

  it("does no evaluation while the feature is off", () => {
    expect(
      evaluateFirstMateAutomaticRouting(
        workspace({ routingEvaluationMode: "off" }),
        "Re-run the CI checks.",
        topicIds.ci,
      ),
    ).toBeNull();
  });
});
