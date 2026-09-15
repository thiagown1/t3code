import type { EnvironmentId, ThreadBundleImportPlan } from "@t3tools/contracts";
import { parseThreadBundleJson } from "@t3tools/shared/threadBundle";
import { FileJsonIcon, UploadIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import {
  summarizeThreadBundleImportPlan,
  threadBundleImportStatusLabel,
} from "./ThreadBundleSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const MAX_THREAD_BUNDLE_BYTES = 5 * 1024 * 1024;

function SummaryValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <p className="text-lg font-medium text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function ThreadBundleImportReview({ plan }: { plan: ThreadBundleImportPlan }) {
  const summary = summarizeThreadBundleImportPlan(plan);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryValue label="Threads" value={summary.threads} />
        <SummaryValue label="Ready" value={summary.readyThreads} />
        <SummaryValue label="Messages" value={summary.messages} />
        <SummaryValue label="Omissions" value={summary.omissions} />
      </div>
      <p className="text-xs text-muted-foreground">
        {summary.attachmentReferences} attachment references · {summary.plans} plans ·{" "}
        {summary.decisions} resolved decisions
      </p>
      <ul className="max-h-72 space-y-2 overflow-auto pr-1">
        {plan.items.map((item) => (
          <li
            key={`${item.sourceEnvironmentId}:${item.sourceThreadId}`}
            className="space-y-1 rounded-lg border border-border/60 px-3 py-2.5"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {item.title}
                </span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {item.sourceEnvironmentId} · {item.sourceThreadId}
                </span>
              </span>
              <Badge variant={item.status === "ready" ? "success" : "warning"}>
                {threadBundleImportStatusLabel(item.status)}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {item.targetProjectId
                ? `Target project: ${item.targetProjectId}`
                : "No target project"}
              {` · ${item.messageCount} messages · ${item.attachmentReferenceCount} attachment references · ${item.omissionCount} omissions`}
            </p>
          </li>
        ))}
      </ul>
      {plan.canImport ? (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-muted-foreground">
          Every thread has a unique project and an available provider. This dry run is ready, but
          persistence is not enabled in this build yet.
        </div>
      ) : (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
          Import is blocked. No thread can be written until every item is ready, so this bundle
          cannot be partially imported.
        </div>
      )}
    </div>
  );
}

function ThreadBundleImportDialog({
  environmentId,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  onOpenChange: (open: boolean) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const [json, setJson] = useState("");
  const [plan, setPlan] = useState<ThreadBundleImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const planImport = useAtomCommand(serverEnvironment.planThreadBundleImport, {
    reportFailure: false,
  });
  const parsed = useMemo(() => {
    if (json.trim().length === 0) return { bundle: null, error: null };
    try {
      return { bundle: parseThreadBundleJson(json), error: null };
    } catch (cause) {
      return {
        bundle: null,
        error: cause instanceof Error ? cause.message : "Invalid Thread Bundle JSON.",
      };
    }
  }, [json]);

  const generatePlan = async () => {
    if (!parsed.bundle) {
      setError(parsed.error ?? "Choose or paste a Thread Bundle first.");
      return;
    }
    const currentRequest = ++requestId.current;
    setError(null);
    setPending(true);
    const result = await planImport({ environmentId, input: { bundle: parsed.bundle } });
    if (currentRequest !== requestId.current) return;
    setPending(false);
    if (result._tag === "Success") {
      setPlan(result.value);
      return;
    }
    setError("Could not compare this bundle with the selected environment. Nothing was changed.");
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{plan ? "Thread Bundle dry run" : "Review Thread Bundle"}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {plan
              ? "Authoritative comparison against the selected environment."
              : "Choose a portable conversation bundle. Parsing and review never write target state."}
          </p>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {plan ? (
            <ThreadBundleImportReview plan={plan} />
          ) : (
            <>
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  if (file.size > MAX_THREAD_BUNDLE_BYTES) {
                    setError("Bundle file is too large (maximum 5 MB). Nothing was read.");
                    return;
                  }
                  void file.text().then(
                    (value) => {
                      setJson(value);
                      setError(null);
                    },
                    () => setError("Could not read that file."),
                  );
                }}
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <FileJsonIcon /> Choose JSON file
              </Button>
              <Textarea
                aria-label="Thread Bundle JSON"
                className="font-mono text-xs"
                value={json}
                onChange={(event) => {
                  setJson(event.currentTarget.value);
                  setError(null);
                }}
                placeholder="Paste a Thread Bundle v1…"
                rows={16}
                spellCheck={false}
              />
              {error ? (
                <p className="text-sm text-destructive-foreground" role="alert">
                  {error}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Runtime sessions, approvals, credentials, locks, processes, attachment content, and
                worktree paths are not importable. Unknown schema versions fail validation.
              </p>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {plan ? "Close review" : "Cancel"}
          </Button>
          {plan ? (
            <Button variant="outline" onClick={() => setPlan(null)}>
              Back
            </Button>
          ) : (
            <Button disabled={pending} onClick={() => void generatePlan()}>
              {pending ? "Checking…" : "Generate dry run"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ThreadBundleSettings() {
  const { target, targets } = useSettingsScope();
  const [importOpen, setImportOpen] = useState(false);
  const available = target !== null && targets.length === 1;
  const status =
    targets.length !== 1
      ? "Select one environment to review a conversation import"
      : target
        ? `Dry run against ${target.label}`
        : "Connect the selected environment to review an import";

  return (
    <SettingsSection id="thread-bundle" title="Conversation portability">
      <SettingsRow
        title="Thread Bundle"
        description="Review a secret-free copy of completed conversation content before importing it into this environment."
        status={status}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!available}
            onClick={() => setImportOpen(true)}
          >
            <UploadIcon /> Review import
          </Button>
        }
        serverScoped
      />
      {importOpen && target ? (
        <ThreadBundleImportDialog
          environmentId={target.environmentId}
          onOpenChange={setImportOpen}
        />
      ) : null}
    </SettingsSection>
  );
}
