import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { finalizeFirstMateDecisionCommand } from "./FirstMateDecisionInbox.actions";

describe("finalizeFirstMateDecisionCommand", () => {
  const environmentId = EnvironmentId.make("environment-local");

  it("refreshes the authoritative shell after a successful decision command", () => {
    const refreshEnvironmentShell = vi.fn();

    expect(
      finalizeFirstMateDecisionCommand({
        result: { _tag: "Success" },
        environmentId,
        refreshEnvironmentShell,
      }),
    ).toBe(true);
    expect(refreshEnvironmentShell).toHaveBeenCalledOnce();
    expect(refreshEnvironmentShell).toHaveBeenCalledWith(environmentId);
  });

  it("does not refresh after a failed decision command", () => {
    const refreshEnvironmentShell = vi.fn();

    expect(
      finalizeFirstMateDecisionCommand({
        result: { _tag: "Failure" },
        environmentId,
        refreshEnvironmentShell,
      }),
    ).toBe(false);
    expect(refreshEnvironmentShell).not.toHaveBeenCalled();
  });
});
