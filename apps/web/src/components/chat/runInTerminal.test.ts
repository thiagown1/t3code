import { describe, expect, it } from "vite-plus/test";

import { isRunnableFenceLanguage, terminalInputForCodeBlock } from "./runInTerminal";

describe("runInTerminal", () => {
  it("offers Run only for shell fences", () => {
    expect(isRunnableFenceLanguage("powershell")).toBe(true);
    expect(isRunnableFenceLanguage("Bash")).toBe(true);
    expect(isRunnableFenceLanguage("typescript")).toBe(false);
    expect(isRunnableFenceLanguage("")).toBe(false);
  });

  it("sends each line with Enter and drops trailing blank lines", () => {
    expect(terminalInputForCodeBlock("git status\r\ngit log -1\n\n")).toBe(
      "git status\rgit log -1",
    );
    expect(terminalInputForCodeBlock("  \n")).toBeNull();
  });
});
