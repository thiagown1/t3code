import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { readLocalApi } from "../localApi";
import { serverEnvironment } from "../state/server";
import {
  buildThreadBundleReviewMessage,
  combineThreadBundleExports,
  downloadThreadBundle,
  planThreadBundleExportRequests,
} from "../threadBundleExport";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";

export function useThreadBundleExport() {
  const exportBundle = useAtomCommand(serverEnvironment.exportThreadBundle, {
    reportFailure: false,
  });

  return useCallback(
    async (selection: ScopedThreadRef | ReadonlyArray<ScopedThreadRef>): Promise<void> => {
      const api = readLocalApi();
      if (!api) {
        toastManager.add({ type: "error", title: "Thread Bundle export is unavailable" });
        return;
      }

      let requests;
      try {
        requests = planThreadBundleExportRequests(
          Array.isArray(selection) ? selection : [selection as ScopedThreadRef],
        );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Cannot export Thread Bundle",
            description: error instanceof Error ? error.message : "Invalid thread selection.",
          }),
        );
        return;
      }

      const results = await Promise.all(requests.map((request) => exportBundle(request)));
      const failed = results.find((result) => result._tag === "Failure");
      if (failed?._tag === "Failure") {
        if (!isAtomCommandInterrupted(failed)) {
          const error = squashAtomCommandFailure(failed);
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

      let bundle;
      try {
        bundle = combineThreadBundleExports(
          results.flatMap((result) => (result._tag === "Success" ? [result.value] : [])),
        );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to prepare Thread Bundle",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }

      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(buildThreadBundleReviewMessage(bundle)),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const filename = downloadThreadBundle(bundle);
      toastManager.add({
        type: "success",
        title: "Thread Bundle downloaded",
        description: filename,
      });
    },
    [exportBundle],
  );
}
