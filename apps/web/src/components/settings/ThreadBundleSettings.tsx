import type {
  EnvironmentId,
  ThreadBundle,
  ThreadBundleImportPlan,
  ThreadBundleImportResult,
} from "@t3tools/contracts";
import { MAX_THREAD_BUNDLE_BYTES, parseThreadBundleJson } from "@t3tools/shared/threadBundle";
import { FileJsonIcon, UploadIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatThreadBundleBytes, summarizeThreadBundle } from "../../threadBundleExport";
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
import { toastManager } from "../ui/toast";
import {
  summarizeThreadBundleImportPlan,
  threadBundleImportStatusLabel,
} from "./ThreadBundleSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function SummaryValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <p className="text-lg font-medium text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function ThreadBundleImportReview({
  bundle,
  plan,
}: {
  bundle: ReturnType<typeof parseThreadBundleJson>;
  plan: ThreadBundleImportPlan;
}) {
  const summary = summarizeThreadBundleImportPlan(plan);
  const bundleSummary = summarizeThreadBundle(bundle);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryValue label="Threads" value={summary.threads} />
        <SummaryValue label="Ready" value={summary.readyThreads} />
        <SummaryValue label="Messages" value={summary.messages} />
        <SummaryValue label="Omissions" value={summary.omissions} />
      </div>
      <p className="text-xs text-muted-foreground">
        {bundle.schemaVersion === 2
          ? `${bundleSummary.embeddedAttachmentCount} attachment file${bundleSummary.embeddedAttachmentCount === 1 ? "" : "s"} included (${formatThreadBundleBytes(bundleSummary.embeddedAttachmentBytes)})`
          : `${bundleSummary.referenceAttachmentCount} attachment references (file contents are not included)`}
        {` · ${summary.plans} plans · ${summary.decisions} resolved decisions`}
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
              {` · ${item.messageCount} messages · ${item.attachmentReferenceCount} attachments · ${item.omissionCount} omissions`}
            </p>
          </li>
        ))}
      </ul>
      {plan.canImport ? (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-muted-foreground">
          Every thread has a unique project and an available provider. Applying this plan creates
          independent settled copies without starting provider sessions.
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
  const [plannedBundle, setPlannedBundle] = useState<ThreadBundle | null>(null);
  const [importResult, setImportResult] = useState<ThreadBundleImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const planImport = useAtomCommand(serverEnvironment.planThreadBundleImport, {
    reportFailure: false,
  });
  const applyImport = useAtomCommand(serverEnvironment.importThreadBundle, {
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
    const bundle = parsed.bundle;
    const currentRequest = ++requestId.current;
    setError(null);
    setPending(true);
    const result = await planImport({ environmentId, input: { bundle } });
    if (currentRequest !== requestId.current) return;
    setPending(false);
    if (result._tag === "Success") {
      setPlan(result.value);
      setPlannedBundle(bundle);
      return;
    }
    setError("Could not compare this bundle with the selected environment. Nothing was changed.");
  };

  const importThreads = async () => {
    if (!plannedBundle || !plan?.canImport) return;
    const currentRequest = ++requestId.current;
    setError(null);
    setPending(true);
    const result = await applyImport({
      environmentId,
      input: { bundle: plannedBundle, expectedPlan: plan },
    });
    if (currentRequest !== requestId.current) return;
    setPending(false);
    if (result._tag === "Success") {
      setImportResult(result.value);
      toastManager.add({
        type: "success",
        title: `${result.value.importedThreads.length} thread${result.value.importedThreads.length === 1 ? "" : "s"} imported`,
        description: "Independent copies were created without starting provider sessions.",
      });
      return;
    }
    setError(
      "The import was rejected or could not be persisted. No partial import was committed; generate a new dry run before retrying.",
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {importResult
              ? "Thread Bundle imported"
              : plan
                ? "Thread Bundle dry run"
                : "Review Thread Bundle"}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {importResult
              ? "The imported conversations are independent from their source installation."
              : plan
                ? "Authoritative comparison against the selected environment."
                : "Choose a portable conversation bundle. Parsing and review never write target state."}
          </p>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {importResult ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
                Imported {importResult.importedThreads.length} settled conversation
                {importResult.importedThreads.length === 1 ? "" : "s"}. Provider sessions,
                approvals, credentials, locks, and processes were not copied.
                {plannedBundle?.schemaVersion === 2
                  ? " Verified attachment files were included in the imported copies."
                  : " Attachment file contents were not copied."}
              </div>
              <ul className="max-h-64 space-y-1 overflow-auto rounded-lg border border-border/60 p-3 font-mono text-xs text-muted-foreground">
                {importResult.importedThreads.map((thread) => (
                  <li key={thread.threadId}>
                    {thread.threadId} · {thread.projectId}
                  </li>
                ))}
              </ul>
            </div>
          ) : plan ? (
            <ThreadBundleImportReview bundle={plannedBundle!} plan={plan} />
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
                  const currentRequest = ++requestId.current;
                  setPlan(null);
                  setPlannedBundle(null);
                  setPending(false);
                  if (file.size > MAX_THREAD_BUNDLE_BYTES) {
                    setJson("");
                    setError(
                      `Bundle file is too large (maximum ${formatThreadBundleBytes(MAX_THREAD_BUNDLE_BYTES)}). Nothing was read.`,
                    );
                    return;
                  }
                  void file.text().then(
                    (value) => {
                      if (currentRequest !== requestId.current) return;
                      setJson(value);
                      setError(null);
                    },
                    () => {
                      if (currentRequest === requestId.current) {
                        setError("Could not read that file.");
                      }
                    },
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
                  requestId.current += 1;
                  setJson(event.currentTarget.value);
                  setPlan(null);
                  setPlannedBundle(null);
                  setPending(false);
                  setError(null);
                }}
                placeholder="Paste a Thread Bundle v1 or v2…"
                rows={16}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Runtime sessions, approvals, credentials, locks, processes, and worktree paths are
                not importable. Version 1 keeps attachment references only; version 2 includes
                integrity-checked attachment files. Unknown schema versions fail validation.
              </p>
            </>
          )}
          {error ? (
            <p className="text-sm text-destructive-foreground" role="alert">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {importResult ? "Close" : plan ? "Close review" : "Cancel"}
          </Button>
          {importResult ? null : plan ? (
            <>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setPlan(null);
                  setPlannedBundle(null);
                  setError(null);
                }}
              >
                Back
              </Button>
              {plan.canImport ? (
                <Button disabled={pending} onClick={() => void importThreads()}>
                  {pending
                    ? "Importing…"
                    : `Import ${plan.items.length} thread${plan.items.length === 1 ? "" : "s"}`}
                </Button>
              ) : null}
            </>
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
        description="Review a portable copy of completed conversation content before importing it into this environment."
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
