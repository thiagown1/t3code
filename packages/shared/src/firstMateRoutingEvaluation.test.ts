import {
  FirstMateTopicId,
  ProjectId,
  ThreadId,
  type FirstMateTopic,
  type FirstMateWorkspaceState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  evaluateFirstMateAutomaticRouting,
  routeFirstMateMessage,
  scoreFirstMateRoutingCandidates,
} from "./firstMate.ts";

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
  it("measures the versioned PT/EN/mixed shadow dataset", () => {
    const tiedTopics = [
      topic({
        id: FirstMateTopicId.make("dataset-production-logs"),
        title: "Production logs",
        summary: "Runtime investigation.",
      }),
      topic({
        id: FirstMateTopicId.make("dataset-firebase-logs"),
        title: "Firebase logs",
        summary: "Data investigation.",
      }),
    ];
    const tiedWorkspace = workspace({ topics: tiedTopics });
    const scenarios = [
      {
        id: "pt-machine",
        message: "A memória e o storage do servidor estão no limite.",
        expected: topicIds.machines,
      },
      {
        id: "pt-ci",
        message: "Os checks do GitHub Actions falharam novamente.",
        expected: topicIds.ci,
      },
      {
        id: "pt-deploy",
        message: "Vamos fazer o deploy atrás de uma feature flag.",
        expected: topicIds.deploy,
      },
      {
        id: "pt-firebase",
        message: "Consultar os logs do Firebase no Firestore.",
        expected: topicIds.firebase,
      },
      {
        id: "en-pr-images",
        message: "The image from the pull request description is not loading.",
        expected: topicIds.prImages,
      },
      {
        id: "en-machine",
        message: "The server has high CPU and memory pressure.",
        expected: topicIds.machines,
      },
      {
        id: "en-ci",
        message: "Run the GitHub checks again.",
        expected: topicIds.ci,
      },
      {
        id: "en-deploy",
        message: "The production deploy is behind a feature flag.",
        expected: topicIds.deploy,
      },
      {
        id: "en-firebase",
        message: "Query Firebase and Firestore logs.",
        expected: topicIds.firebase,
      },
      {
        id: "mixed-machine",
        message: "Confira o storage do host and memory usage.",
        expected: topicIds.machines,
      },
      {
        id: "mixed-ci",
        message: "Os checks da pipeline failed novamente.",
        expected: topicIds.ci,
      },
      {
        id: "mixed-deploy",
        message: "Fazer deploy com uma feature flag.",
        expected: topicIds.deploy,
      },
      {
        id: "mixed-pr-images",
        message: "Carregar imagens da descrição do pull request.",
        expected: topicIds.prImages,
      },
      {
        id: "negative-semantic",
        message: "A esteira ficou vermelha.",
        expected: null,
      },
      {
        id: "negative-generic",
        message: "Please help me with this problem.",
        expected: null,
      },
      {
        id: "negative-ambiguous",
        message: "Verifique os logs.",
        expected: null,
      },
      {
        id: "ambiguous-tie",
        message: "Inspect logs",
        expected: null,
        state: tiedWorkspace,
      },
      {
        id: "degenerate-empty",
        message: "",
        expected: null,
      },
      {
        id: "degenerate-punctuation",
        message: "???",
        expected: null,
      },
    ] as const;

    const results = scenarios.map((scenario) => ({
      ...scenario,
      state: "state" in scenario ? scenario.state : workspace(),
      evaluation: evaluateFirstMateAutomaticRouting(
        "state" in scenario ? scenario.state : workspace(),
        scenario.message,
        scenario.expected ?? topicIds.ci,
      ),
      candidates: scoreFirstMateRoutingCandidates(
        "state" in scenario ? scenario.state : workspace(),
        scenario.message,
      ),
    }));

    const suggestions = results.filter((result) => result.evaluation?.candidateTopicId !== null);
    const correct = suggestions.filter(
      (result) => result.evaluation?.candidateTopicId === result.expected,
    );
    const falsePositives = results.filter(
      (result) => result.expected === null && result.evaluation?.candidateTopicId !== null,
    );
    const abstentions = results.filter((result) => result.evaluation?.candidateTopicId === null);
    const ties = results.filter(
      (result) =>
        (result.candidates[0]?.score ?? 0) > 0 &&
        result.candidates[0]?.score === result.candidates[1]?.score,
    );
    const metrics = {
      total: results.length,
      suggestions: suggestions.length,
      coverage: suggestions.length / results.length,
      correct: correct.length,
      precisionWhenSuggested: correct.length / suggestions.length,
      abstentions: abstentions.length,
      abstentionRate: abstentions.length / results.length,
      falsePositives: falsePositives.length,
      ties: ties.length,
      minimumSuggestedMargin: Math.min(
        ...suggestions.map(
          (result) => result.candidates[0]!.score - (result.candidates[1]?.score ?? 0),
        ),
      ),
    };

    expect(metrics).toEqual({
      total: 19,
      suggestions: 13,
      coverage: 13 / 19,
      correct: 13,
      precisionWhenSuggested: 1,
      abstentions: 6,
      abstentionRate: 6 / 19,
      falsePositives: 0,
      ties: 1,
      minimumSuggestedMargin: 3,
    });

    for (const result of results) {
      expect(result.evaluation?.candidateTopicId).toBe(result.expected);
      expect(
        evaluateFirstMateAutomaticRouting(
          result.state.topics === tiedTopics
            ? workspace({ topics: [...tiedTopics].reverse() })
            : workspace({ topics: [...topics].reverse() }),
          result.message,
          result.expected ?? topicIds.ci,
        ),
      ).toEqual(result.evaluation);
    }
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
