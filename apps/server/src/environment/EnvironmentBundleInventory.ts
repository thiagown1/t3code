import * as NodeCrypto from "node:crypto";

import type {
  EnvironmentBundleProjectInstruction,
  EnvironmentBundleServerInventory,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const MAX_PROJECT_INSTRUCTION_BYTES = FileSystem.Size(256_000);

/**
 * Root instruction files with stable, portable paths. Provider-specific
 * nested discovery remains deliberately partial until each adapter reports
 * the exact files it loaded for a session.
 */
export const ROOT_PROJECT_INSTRUCTION_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
] as const;

function isWithinRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const resolveProjectRoot = Effect.fn("resolveEnvironmentBundleProjectRoot")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const initial = yield* fileSystem
    .realPath(cwd)
    .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  let candidate = initial;

  while (true) {
    const gitMarkerExists = yield* fileSystem
      .exists(path.join(candidate, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (gitMarkerExists) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return initial;
    candidate = parent;
  }
});

const readProjectInstruction = Effect.fn("readEnvironmentBundleProjectInstruction")(function* (
  root: string,
  logicalPath: (typeof ROOT_PROJECT_INSTRUCTION_PATHS)[number],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidate = yield* fileSystem.realPath(path.join(root, logicalPath));
  if (!isWithinRoot(path, root, candidate)) return null;
  const info = yield* fileSystem.stat(candidate);
  if (info.type !== "File" || info.size > MAX_PROJECT_INSTRUCTION_BYTES) return null;
  const contents = yield* fileSystem.readFile(candidate);
  return {
    logicalPath,
    contentHash: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
    enabled: true,
  } satisfies EnvironmentBundleProjectInstruction;
});

export const loadEnvironmentBundleServerInventory = Effect.fn(
  "loadEnvironmentBundleServerInventory",
)(function* (
  cwd: string,
): Effect.fn.Return<EnvironmentBundleServerInventory, never, FileSystem.FileSystem | Path.Path> {
  const root = yield* resolveProjectRoot(cwd);
  const projectInstructions = yield* Effect.forEach(
    ROOT_PROJECT_INSTRUCTION_PATHS,
    (logicalPath) =>
      readProjectInstruction(root, logicalPath).pipe(Effect.orElseSucceed(() => null)),
    { concurrency: "unbounded" },
  );
  const availableProjectInstructions = projectInstructions.filter((entry) => entry !== null);

  return {
    // Provider-native MCP configuration may contain commands, tokens, and
    // local paths. Adapters must publish a sanitized view before this can be
    // anything other than unavailable.
    mcpServers: [],
    mcpCoverage: "unavailable",
    projectInstructions: availableProjectInstructions,
    projectInstructionsCoverage: "partial",
  };
});
