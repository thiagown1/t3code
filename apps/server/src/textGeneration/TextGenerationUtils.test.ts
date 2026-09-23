import { describe, expect, it } from "vite-plus/test";

import { summarizeCliFailure } from "./TextGenerationUtils.ts";

describe("summarizeCliFailure", () => {
  it("reports the CLI's reason instead of the prompt it echoed first", () => {
    // Shape observed from a real `codex exec` run: banner, then the whole
    // prompt (a text generation prompt carries the thread transcript), then the
    // reason, repeated once per attempt.
    const stdout = [
      "OpenAI Codex v0.155.0",
      "workdir: C:\\Users\\Thiago\\turbo_station",
      "model: gpt-5.6-luna",
      "user",
      'Regenerate the title for an existing T3 Code thread. The previous title was "sweep rate".',
      "Thread contents:",
      "USER: deliver green ci",
      "ASSISTANT: Todo o CI de codigo esta verde agora.",
      "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 23rd, 2026 9:07 AM.",
      "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 23rd, 2026 9:07 AM.",
    ].join("\n");

    const detail = summarizeCliFailure({ stdout, stderr: "" });

    expect(detail).toBe(
      "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 23rd, 2026 9:07 AM.",
    );
    expect(detail).not.toContain("sweep rate");
    expect(detail).not.toContain("deliver green ci");
  });

  it("prefers stderr when the CLI used it", () => {
    expect(
      summarizeCliFailure({ stdout: "banner\nprompt echo", stderr: "  error: not logged in  " }),
    ).toBe("error: not logged in");
  });

  it("falls back to the tail, where a CLI that failed without a marker says why", () => {
    const stdout = ["banner", "prompt line", "a", "b", "c"].join("\n");

    expect(summarizeCliFailure({ stdout, stderr: "" })).toBe("a\nb\nc");
  });

  it("has nothing to report when the CLI printed nothing", () => {
    expect(summarizeCliFailure({ stdout: "   \n  ", stderr: "" })).toBeUndefined();
  });

  it("bounds a CLI that fails verbosely", () => {
    const stdout = `error: ${"x".repeat(5_000)}`;

    const detail = summarizeCliFailure({ stdout, stderr: "" });

    expect(detail).toContain("[truncated]");
    expect(detail!.length).toBeLessThan(700);
  });
});
