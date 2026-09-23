import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveLegacyPlanModeEnabled } from "./legacy-plan-mode";

/**
 * Keep compatibility with older device preferences while promoting T3's
 * interaction mode to a standard composer control once preferences hydrate.
 */
export function useLegacyPlanModeState(): { readonly enabled: boolean; readonly loaded: boolean } {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  return {
    enabled: resolveLegacyPlanModeEnabled({
      loaded,
      preference: loaded ? preferences.value.planModeEnabled : undefined,
    }),
    loaded,
  };
}
