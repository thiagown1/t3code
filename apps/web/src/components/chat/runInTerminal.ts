import { createContext } from "react";

/**
 * Runs a chat code block in the thread's terminal. Provided by the chat view;
 * markdown rendered anywhere else (PR panels, plans) has no terminal and gets
 * no Run button.
 */
export const RunInTerminalContext = createContext<((command: string) => void) | null>(null);

const RUNNABLE_FENCE_LANGUAGES = new Set([
  "powershell",
  "pwsh",
  "ps1",
  "bash",
  "sh",
  "shell",
  "zsh",
  "cmd",
  "bat",
]);

export function isRunnableFenceLanguage(language: string): boolean {
  return RUNNABLE_FENCE_LANGUAGES.has(language.trim().toLowerCase());
}

/**
 * Terminal command for a code block: lines separated by Enter, trailing blank
 * lines dropped. The runner adds the final Enter.
 */
export function terminalInputForCodeBlock(code: string): string | null {
  const lines = code.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.length === 1 && lines[0]!.trim() === "") return null;
  return lines.join("\r");
}
