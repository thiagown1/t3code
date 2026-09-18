import { describe, expect, it } from "vite-plus/test";

import { formatRoundTranscript } from "./RoundSummaryContext.ts";

describe("formatRoundTranscript", () => {
  it("keeps the round in order and labels each speaker", () => {
    const transcript = formatRoundTranscript([
      { role: "user", text: "Fix the failing auth test." },
      { role: "system", text: "ignored" },
      { role: "assistant", text: "Fixed the token clock skew in AuthSession." },
    ]);

    expect(transcript).toBe(
      "USER:\nFix the failing auth test.\n\nASSISTANT:\nFixed the token clock skew in AuthSession.",
    );
  });

  it("returns nothing when the round carries no usable text", () => {
    expect(
      formatRoundTranscript([
        { role: "system", text: "boot" },
        { role: "user", text: "  " },
      ]),
    ).toBe("");
  });

  it("drops the opening of an oversized round rather than its outcome", () => {
    const transcript = formatRoundTranscript([
      { role: "user", text: "the request that opened this round" },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: "assistant" as const,
        text: `step-${index} ${"b".repeat(3_000)}`,
      })),
      { role: "assistant", text: "Tests pass; the migration is still unwritten." },
    ]);

    expect(transcript.startsWith("[Earlier content truncated]")).toBe(true);
    expect(transcript.endsWith("Tests pass; the migration is still unwritten.")).toBe(true);
    expect(transcript).not.toContain("the request that opened this round");
    expect(transcript).not.toContain("step-0");
    expect(transcript).toContain("step-7");
    expect(transcript.length).toBeLessThanOrEqual(12_000);
  });
});
