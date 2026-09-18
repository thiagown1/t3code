import { TextGenerationError } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  // The type side, so decoding defaults do not turn required fields into
  // optional ones, and closed objects (`additionalProperties: false`):
  // structured-output modes require both, and closed was the generator
  // default before effect rc.113.
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema), {
    onExcessProperty: "error",
  });
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

// Prompts ask for under 40 characters. This cap only stops a runaway model
// from pushing a paragraph into the sidebar, header, and window title.
const MAX_THREAD_TITLE_CHARS = 120;

/** Normalise a raw thread title to a single line. Clients truncate for display. */
export function sanitizeThreadTitle(raw: string): string {
  // Unwrap a JSON-formatted title before truncation can cut off the closing brace.
  const decoded = decodeJsonThreadTitle(raw);
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= MAX_THREAD_TITLE_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_THREAD_TITLE_CHARS - 3).trimEnd()}...`;
}

// The prompt asks for under 600 characters. This cap only stops a runaway
// model from pushing a transcript into the supervisor's topic listing.
const MAX_ROUND_SUMMARY_CHARS = 1_000;

/**
 * Normalise a generated round summary to one bounded paragraph. Returns an
 * empty string when the model produced nothing; callers treat that as "no
 * summary" rather than recording a blank one.
 */
export function sanitizeRoundSummary(raw: string): string {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized.length <= MAX_ROUND_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ROUND_SUMMARY_CHARS - 3).trimEnd()}...`;
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

/**
 * Lines that mark the reason a provider CLI gave up, rather than the prompt it
 * echoed on the way there.
 */
const CLI_FAILURE_MARKERS =
  /^\s*(?:error\b|fatal\b|panic\b|stream error\b|.*\busage limit\b|.*\brate limit\b|.*\bquota\b|.*\bunauthorized\b|.*\bnot (?:logged in|authenticated)\b)/i;

const CLI_FAILURE_DETAIL_MAX_CHARS = 600;

/**
 * Describe why a provider CLI exited non-zero, in terms a user can act on.
 *
 * Codex and Claude both echo their banner and the whole prompt to stdout before
 * the failure line, and a text generation prompt carries the thread transcript.
 * Reporting that verbatim buries the reason — a spent quota reached the user as
 * thousands of characters of their own conversation with the log truncating the
 * one line that mattered.
 *
 * stderr wins when the CLI used it. Otherwise the marker lines are pulled out of
 * stdout, newest first, because the CLI prints the prompt before it fails. With
 * no marker the tail is still a better guess than the head, for the same reason.
 */
export function summarizeCliFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): string | undefined {
  const stderr = input.stderr.trim();
  if (stderr.length > 0) return limitSection(stderr, CLI_FAILURE_DETAIL_MAX_CHARS);

  const lines = input.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;

  const markers = lines.filter((line) => CLI_FAILURE_MARKERS.test(line));
  // Duplicate failure lines are common: the CLI reports per attempt.
  const unique = [...new Set(markers.length > 0 ? markers : lines.slice(-3))];
  return limitSection(unique.join("\n"), CLI_FAILURE_DETAIL_MAX_CHARS);
}
