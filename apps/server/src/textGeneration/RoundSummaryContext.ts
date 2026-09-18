/**
 * Transcript recorte for round summaries.
 *
 * The whole point of the summary layer is that a cheap model reads one round
 * instead of an expensive model rereading the thread, so this module is the
 * cost lever: it bounds what leaves for the prompt. Sections are collected
 * from the end of the round because the outcome lives there; when the budget
 * runs out it is the opening of the round that is dropped, never the result.
 *
 * @module RoundSummaryContext
 */
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

import { limitTitleMessage } from "./ThreadTitleContext.ts";

export type RoundMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
};

const MAX_TRANSCRIPT = 12_000;
const MAX_MESSAGE = 3_000;
const OMITTED = "[Earlier content truncated]\n\n";

/** Format the messages of one round into a bounded, newest-last transcript. */
export function formatRoundTranscript(messages: ReadonlyArray<RoundMessage>): string {
  const sections = messages.flatMap((message) => {
    if (message.role === "system") return [];
    const contents = assistantCitationsToPlainText(message.text).trim();
    return contents.length === 0 ? [] : [{ prefix: `${message.role.toUpperCase()}:\n`, contents }];
  });

  const kept: string[] = [];
  let remaining = MAX_TRANSCRIPT - OMITTED.length;
  let truncated = false;

  for (const section of sections.toReversed()) {
    const budget = Math.min(MAX_MESSAGE, remaining - section.prefix.length - 2);
    const contents = budget > 0 ? limitTitleMessage(section.contents, budget) : "";
    if (contents.length === 0) {
      truncated = true;
      break;
    }
    if (contents !== section.contents) truncated = true;
    const text = section.prefix + contents;
    kept.push(text);
    remaining -= text.length + 2;
  }

  if (kept.length === 0) return "";
  return `${truncated || kept.length < sections.length ? OMITTED : ""}${kept.toReversed().join("\n\n")}`;
}
