import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { readLocalApi } from "../localApi";
import { serverEnvironment } from "../state/server";
import { downloadThreadBundle, buildThreadBundleReviewMessage } from "../threadBundleExport";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";

export function useThreadBundleExport() {
  const exportBundle = useAtomCommand(serverEnvironment.exportThreadBundle, {
    reportFailure: false,
  });

  return useCallback(
    async (threadRef: ScopedThreadRef): Promise<void> => {
      const api = readLocalApi();
      if (!api) {
        toastManager.add({ type: "error", title: "Thread Bundle export is unavailable" });
        return;
      }

      const result = await exportBundle({
        environmentId: threadRef.environmentId,
        input: { threadIds: [threadRef.threadId] },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to prepare Thread Bundle",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(buildThreadBundleReviewMessage(result.value)),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const filename = downloadThreadBundle(result.value);
      toastManager.add({
        type: "success",
        title: "Thread Bundle downloaded",
        description: filename,
      });
    },
    [exportBundle],
  );
}
