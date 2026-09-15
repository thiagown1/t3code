import type { EnvironmentBundle, EnvironmentBundleInventoryCoverage } from "@t3tools/contracts";
import {
  parseEnvironmentBundleJson,
  serializeEnvironmentBundle,
} from "@t3tools/shared/environmentBundle";
import { DownloadIcon, EyeIcon, FileJsonIcon, UploadIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

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
  buildEnvironmentBundleInventory,
  environmentBundleDownloadName,
  summarizeEnvironmentBundleDiff,
} from "./EnvironmentBundleSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useScopedSettingsMixed } from "./useScopedSettings";

const MAX_ENVIRONMENT_BUNDLE_BYTES = 1024 * 1024;

function downloadBundle(bundle: EnvironmentBundle): void {
  const url = URL.createObjectURL(
    new Blob([serializeEnvironmentBundle(bundle)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = environmentBundleDownloadName(bundle);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function InventoryCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <p className="text-lg font-medium text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function InventoryList({
  empty,
  items,
}: {
  empty: string;
  items: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly enabled: boolean;
  }>;
}) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="max-h-44 space-y-1 overflow-auto pr-1">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-start justify-between gap-3 rounded-md border border-border/50 px-2.5 py-2"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm text-foreground">{item.label}</span>
            <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
          </span>
          <Badge variant={item.enabled ? "success" : "secondary"}>
            {item.enabled ? "Enabled" : "Disabled"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function CoverageBadge({ value }: { value: EnvironmentBundleInventoryCoverage }) {
  return <Badge variant={value === "complete" ? "success" : "secondary"}>{value}</Badge>;
}

function EnvironmentBundleInventoryDialog({
  bundle,
  mcpCoverage,
  projectInstructionsCoverage,
  onOpenChange,
}: {
  bundle: EnvironmentBundle;
  mcpCoverage: EnvironmentBundleInventoryCoverage;
  projectInstructionsCoverage: EnvironmentBundleInventoryCoverage;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Environment inventory</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Sanitized metadata only. This view never displays commands, credentials, URLs, or
            absolute paths.
          </p>
        </DialogHeader>
        <DialogPanel className="grid gap-4 sm:grid-cols-2">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">MCP servers ({bundle.mcpServers.length})</h3>
              <CoverageBadge value={mcpCoverage} />
            </div>
            <InventoryList
              empty="No MCP metadata is safely available."
              items={bundle.mcpServers.map((server) => ({
                id: server.serverId,
                label: server.serverId,
                detail: `${server.origin} · ${server.allowedTools.length} allowed · ${server.blockedTools.length} blocked`,
                enabled: server.enabled,
              }))}
            />
          </section>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Project instructions</h3>
              <CoverageBadge value={projectInstructionsCoverage} />
            </div>
            <InventoryList
              empty="No known project instructions were detected."
              items={bundle.projectInstructions.map((instruction) => ({
                id: instruction.logicalPath,
                label: instruction.logicalPath,
                detail: `SHA-256 ${instruction.contentHash.slice(0, 12)}…`,
                enabled: instruction.enabled,
              }))}
            />
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Skills ({bundle.skills.length})</h3>
            <InventoryList
              empty="No skills were reported."
              items={bundle.skills.map((skill) => ({
                id: skill.skillId,
                label: skill.name,
                detail: `${skill.origin}${skill.providedByPluginId ? ` · ${skill.providedByPluginId}` : ""}`,
                enabled: skill.enabled,
              }))}
            />
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">
              Providers and integrations ({bundle.providers.length + bundle.pluginsAndApps.length})
            </h3>
            <InventoryList
              empty="No providers or integrations were reported."
              items={[
                ...bundle.providers.map((provider) => ({
                  id: `provider:${provider.instanceId}`,
                  label: provider.instanceId,
                  detail: `provider · ${provider.driver}${provider.version ? ` · ${provider.version}` : ""}`,
                  enabled: provider.enabled,
                })),
                ...bundle.pluginsAndApps.map((integration) => ({
                  id: `integration:${integration.integrationId}`,
                  label: integration.integrationId,
                  detail: integration.kind,
                  enabled: integration.enabled,
                })),
              ]}
            />
          </section>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EnvironmentBundleReview({
  current,
  incoming,
}: {
  current: EnvironmentBundle;
  incoming: EnvironmentBundle;
}) {
  const summary = summarizeEnvironmentBundleDiff(current, incoming);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" aria-label="Environment Bundle changes">
        <Badge variant="success">{summary.added} added</Badge>
        <Badge variant="warning">{summary.changed} changed</Badge>
        <Badge variant="error">{summary.removed} removed</Badge>
        {summary.metadataChanged ? <Badge variant="secondary">metadata changed</Badge> : null}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <InventoryCount
          label="capabilities"
          value={incoming.capabilityProfile.capabilities.length}
        />
        <InventoryCount label="MCP servers" value={incoming.mcpServers.length} />
        <InventoryCount label="skills" value={incoming.skills.length} />
        <InventoryCount label="plugins/apps" value={incoming.pluginsAndApps.length} />
        <InventoryCount label="providers" value={incoming.providers.length} />
        <InventoryCount label="instructions" value={incoming.projectInstructions.length} />
      </div>
      {summary.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No application steps.</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border border-border/60 p-3 font-mono text-xs">
          {summary.steps.slice(0, 100).map((step) => (
            <li key={`${step.component}:${step.id}:${step.operation}`}>
              {step.operation === "add" ? "+" : step.operation === "remove" ? "−" : "~"}{" "}
              {step.component}:{step.id}
              {step.requiresProviderReload ? " · reload" : ""}
              {step.healthCheckRequired ? " · health check" : ""}
            </li>
          ))}
          {summary.steps.length > 100 ? (
            <li className="text-muted-foreground">… {summary.steps.length - 100} more steps</li>
          ) : null}
        </ul>
      )}
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
        Dry run only. T3 has not installed, enabled, restarted, or changed anything. Applying a
        bundle stays unavailable until destination credential resolution and provider/MCP health
        checks are implemented.
      </div>
    </div>
  );
}

function EnvironmentBundleImportDialog({
  current,
  onOpenChange,
}: {
  current: EnvironmentBundle;
  onOpenChange: (open: boolean) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState(() => serializeEnvironmentBundle(current));
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => {
    try {
      return { bundle: parseEnvironmentBundleJson(json), error: null };
    } catch (cause) {
      return {
        bundle: null,
        error: cause instanceof Error ? cause.message : "Invalid Environment Bundle JSON.",
      };
    }
  }, [json]);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {step === "edit" ? "Review Environment Bundle" : "Dry-run plan"}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {step === "edit"
              ? "Paste or choose a secret-free bundle. Parsing and review do not modify this environment."
              : `Canonical comparison against ${current.name}.`}
          </p>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {step === "edit" ? (
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
                  if (file.size > MAX_ENVIRONMENT_BUNDLE_BYTES) {
                    setError("Bundle file is too large (maximum 1 MB). Nothing was read.");
                    return;
                  }
                  void file.text().then(setJson, () => setError("Could not read that file."));
                }}
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <FileJsonIcon /> Choose JSON file
              </Button>
              <Textarea
                aria-label="Environment Bundle JSON"
                className="font-mono text-xs"
                value={json}
                onChange={(event) => {
                  setJson(event.currentTarget.value);
                  setError(null);
                }}
                rows={16}
                spellCheck={false}
              />
              {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
              <p className="text-xs text-muted-foreground">
                Unknown fields are discarded. Absolute paths, duplicate IDs, malformed hashes, and
                conflicting MCP rules fail validation.
              </p>
            </>
          ) : parsed.bundle ? (
            <EnvironmentBundleReview current={current} incoming={parsed.bundle} />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {step === "review" ? "Close review" : "Cancel"}
          </Button>
          {step === "review" ? (
            <Button variant="outline" onClick={() => setStep("edit")}>
              Back
            </Button>
          ) : (
            <Button
              onClick={() => {
                if (!parsed.bundle) {
                  setError(parsed.error ?? "Invalid Environment Bundle JSON.");
                  return;
                }
                setError(null);
                setStep("review");
              }}
            >
              Generate dry run
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function EnvironmentBundleSettings() {
  const capabilityProfile = useScopedSettings((settings) => settings.capabilityProfile);
  const mixed = useScopedSettingsMixed(["capabilityProfile"]);
  const { environment, target, targets } = useSettingsScope();
  const [importOpen, setImportOpen] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const serverConfig = environment?.serverConfig ?? null;
  const bundle = useMemo(
    () =>
      !serverConfig || !target || mixed
        ? null
        : buildEnvironmentBundleInventory({
            environmentId: target.environmentId,
            environmentLabel: target.label,
            cwd: serverConfig.cwd ?? null,
            capabilityProfile,
            providers: serverConfig.providers,
            ...(serverConfig.environmentBundleInventory
              ? { serverInventory: serverConfig.environmentBundleInventory }
              : {}),
          }),
    [capabilityProfile, mixed, serverConfig, target],
  );

  const status = mixed
    ? "Unavailable for mixed capability profiles"
    : targets.length !== 1
      ? "Select one environment to create a portable snapshot"
      : bundle
        ? `${bundle.providers.length} providers · ${bundle.skills.length} skills · ${bundle.pluginsAndApps.length} plugins/apps · ${bundle.projectInstructions.length} instructions${serverConfig?.environmentBundleInventory?.mcpCoverage === "unavailable" ? " · MCP inventory unavailable" : ` · ${bundle.mcpServers.length} MCPs${serverConfig?.environmentBundleInventory?.mcpCoverage === "partial" ? " (partial)" : ""}`}`
        : "Connect the selected environment to build its inventory";

  return (
    <SettingsSection id="environment-bundle" title="Environment portability">
      <SettingsRow
        title="Environment Bundle"
        description="Secret-free snapshot of capability policy, provider versions, skills, known instruction hashes, and sanitized MCP metadata. Coverage remains explicit when a provider cannot report safely."
        status={status}
        control={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={bundle === null || targets.length !== 1}
              onClick={() => setInventoryOpen(true)}
            >
              <EyeIcon /> View inventory
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={bundle === null || targets.length !== 1}
              onClick={() => bundle && downloadBundle(bundle)}
            >
              <DownloadIcon /> Export bundle
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={bundle === null || targets.length !== 1}
              onClick={() => setImportOpen(true)}
            >
              <UploadIcon /> Review import
            </Button>
          </>
        }
        serverScoped
        settingKeys={["capabilityProfile"]}
        mixed={mixed}
      />
      {importOpen && bundle ? (
        <EnvironmentBundleImportDialog current={bundle} onOpenChange={setImportOpen} />
      ) : null}
      {inventoryOpen && bundle ? (
        <EnvironmentBundleInventoryDialog
          bundle={bundle}
          mcpCoverage={serverConfig?.environmentBundleInventory?.mcpCoverage ?? "unavailable"}
          projectInstructionsCoverage={
            serverConfig?.environmentBundleInventory?.projectInstructionsCoverage ?? "unavailable"
          }
          onOpenChange={setInventoryOpen}
        />
      ) : null}
    </SettingsSection>
  );
}
