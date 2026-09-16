import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const findEnvironmentBundleRepositoryRoot = Effect.fn("findEnvironmentBundleRepositoryRoot")(
  function* (cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = path.resolve(cwd);
    while (true) {
      if (
        yield* fileSystem.exists(path.join(current, ".git")).pipe(Effect.orElseSucceed(() => false))
      ) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(cwd);
      current = parent;
    }
  },
);
