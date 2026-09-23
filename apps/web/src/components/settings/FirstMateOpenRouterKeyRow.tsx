import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

/**
 * The environment's OpenRouter key for Jev turn review. Write-only: the
 * server only ever tells the client whether a key is configured.
 */
export function FirstMateOpenRouterKeyRow({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const { data, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.firstMateOpenRouterKeyStatus({ environmentId, input: {} }),
  );
  const setKey = useAtomCommand(serverEnvironment.setFirstMateOpenRouterKey, {
    label: "Save OpenRouter API key",
  });
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const configured = data?.configured ?? false;

  const save = async (key: string | null) => {
    if (environmentId === null) return;
    setPending(true);
    const result = await setKey({ environmentId, input: { key } });
    setPending(false);
    if (result._tag === "Success") {
      setDraft("");
      refresh();
    }
  };

  return (
    <SettingsRow
      id="firstmate-openrouter-key"
      title="OpenRouter API key"
      description={
        configured
          ? "Used by Jev turn review on this environment. The key is never shown again."
          : "Jev turn review needs an OpenRouter API key on this environment. Until one is set, turns are not reviewed."
      }
      status={data === null ? undefined : configured ? "Configured" : "Not set"}
      control={
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            aria-label="OpenRouter API key"
            placeholder={configured ? "Replace key" : "sk-or-…"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pending || environmentId === null || draft.trim().length === 0}
            onClick={() => void save(draft)}
          >
            Save
          </Button>
          {configured ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || environmentId === null}
              onClick={() => void save(null)}
            >
              Clear
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
