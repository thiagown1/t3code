import type { EnvironmentId } from "@t3tools/contracts";

export function finalizeFirstMateShellCommand(input: {
  readonly result: { readonly _tag: string };
  readonly environmentId: EnvironmentId;
  readonly refreshEnvironmentShell: (environmentId: EnvironmentId) => void;
}): boolean {
  if (input.result._tag !== "Success") return false;
  input.refreshEnvironmentShell(input.environmentId);
  return true;
}
