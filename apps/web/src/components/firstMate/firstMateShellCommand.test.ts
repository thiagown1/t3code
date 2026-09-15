import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { finalizeFirstMateShellCommand } from "./firstMateShellCommand";

describe("finalizeFirstMateShellCommand", () => {
  const environmentId = EnvironmentId.make("environment-local");

  it("refreshes the authoritative shell after a successful command", () => {
    const refreshEnvironmentShell = vi.fn();

    expect(
      finalizeFirstMateShellCommand({
        result: { _tag: "Success" },
        environmentId,
        refreshEnvironmentShell,
      }),
    ).toBe(true);
    expect(refreshEnvironmentShell).toHaveBeenCalledOnce();
    expect(refreshEnvironmentShell).toHaveBeenCalledWith(environmentId);
  });

  it("does not refresh after a failed command", () => {
    const refreshEnvironmentShell = vi.fn();

    expect(
      finalizeFirstMateShellCommand({
        result: { _tag: "Failure" },
        environmentId,
        refreshEnvironmentShell,
      }),
    ).toBe(false);
    expect(refreshEnvironmentShell).not.toHaveBeenCalled();
  });
});
