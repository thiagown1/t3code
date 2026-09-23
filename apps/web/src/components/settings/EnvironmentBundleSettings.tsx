import type {
  EnvironmentBundle,
  EnvironmentBundleApplyPlan,
  EnvironmentBundleCredentialResolutions,
  EnvironmentBundleInventoryCoverage,
  EnvironmentId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  parseEnvironmentBundleJson,
  serializeEnvironmentBundle,
} from "@t3tools/shared/environmentBundle";
import { DownloadIcon, EyeIcon, FileJsonIcon, UploadIcon } from "lucide-react";
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
import { Switch } from "../ui/switch";
import {
  buildEnvironmentBundleSettingsPatch,
  buildEnvironmentBundleInventory,
  collectEnvironmentBundleCredentialReferences,
  environmentBundleCapabilityId,
  environmentBundleApplyMode,
  environmentBundleDownloadName,
  type EnvironmentBundleEnablementTarget,
  getEnvironmentBundleApplyReadiness,
  setEnvironmentBundleEntryEnabled,
  summarizeEnvironmentBundleCredentialResolutions,
  summarizeEnvironmentBundleDiff,
} from "./EnvironmentBundleSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

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
                detail: `${server.origin} · ${server.credentialRefs.length} credential refs · ${server.allowedTools.length} allowed · ${server.blockedTools.length} blocked`,
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
  authoritativePlan,
  authoritativePlanError,
  authoritativePlanPending,
  credentialResolutions,
  credentialResolutionError,
  credentialResolutionPending,
  current,
  incoming,
  onIncomingChange,
  providerInstances,
  providers,
}: {
  authoritativePlan: EnvironmentBundleApplyPlan | null;
  authoritativePlanError: string | null;
  authoritativePlanPending: boolean;
  credentialResolutions: EnvironmentBundleCredentialResolutions | null;
  credentialResolutionError: string | null;
  credentialResolutionPending: boolean;
  current: EnvironmentBundle;
  incoming: EnvironmentBundle;
  onIncomingChange: (incoming: EnvironmentBundle) => void;
  providerInstances: ServerSettings["providerInstances"];
  providers: ServerSettings["providers"];
}) {
  const summary = summarizeEnvironmentBundleDiff(current, incoming);
  const applyReadiness = getEnvironmentBundleApplyReadiness(current, incoming, {
    providerInstances,
    providers,
    ...(credentialResolutions ? { credentialResolutions } : {}),
  });
  const applyMode = environmentBundleApplyMode(applyReadiness, authoritativePlan);
  const credentialSummary = credentialResolutions
    ? summarizeEnvironmentBundleCredentialResolutions(credentialResolutions)
    : null;
  const enablementEntries: ReadonlyArray<{
    readonly target: EnvironmentBundleEnablementTarget;
    readonly label: string;
    readonly detail: string;
    readonly enabled: boolean;
  }> = [
    ...incoming.capabilityProfile.capabilities.map((capability) => ({
      target: {
        component: "capability" as const,
        id: environmentBundleCapabilityId(capability),
      },
      label: capability.capabilityId,
      detail: `capability${capability.state === "unavailable" ? " · unavailable at source" : ""}`,
      enabled: capability.state === "enabled",
    })),
    ...incoming.mcpServers.map((server) => ({
      target: { component: "mcp-server" as const, id: server.serverId },
      label: server.serverId,
      detail: "MCP server",
      enabled: server.enabled,
    })),
    ...incoming.skills.map((skill) => ({
      target: { component: "skill" as const, id: skill.skillId },
      label: skill.name,
      detail: `skill · ${skill.origin}`,
      enabled: skill.enabled,
    })),
    ...incoming.pluginsAndApps.map((integration) => ({
      target: {
        component: "plugin-app" as const,
        id: `${integration.kind}:${integration.integrationId}`,
      },
      label: integration.integrationId,
      detail: `${integration.kind} · project policy for provided skills; does not uninstall`,
      enabled: integration.enabled,
    })),
    ...incoming.providers.map((provider) => ({
      target: { component: "provider" as const, id: provider.instanceId },
      label: provider.instanceId,
      detail: `provider · ${provider.driver}`,
      enabled: provider.enabled,
    })),
    ...incoming.projectInstructions.map((instruction) => ({
      target: { component: "project-instruction" as const, id: instruction.logicalPath },
      label: instruction.logicalPath,
      detail: "project instruction",
      enabled: instruction.enabled,
    })),
  ];
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
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Local credential references</h3>
          <p className="text-xs text-muted-foreground">
            Checks only the named references on this environment. Credential values never leave the
            server.
          </p>
        </div>
        {credentialResolutionPending ? (
          <p className="text-xs text-muted-foreground">Checking local references…</p>
        ) : credentialResolutionError ? (
          <p className="text-xs text-destructive-foreground">{credentialResolutionError}</p>
        ) : credentialResolutions?.length === 0 ? (
          <p className="text-xs text-muted-foreground">No credential references in this bundle.</p>
        ) : credentialResolutions && credentialSummary ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="success">{credentialSummary.resolved} resolved</Badge>
              <Badge variant={credentialSummary.missing > 0 ? "warning" : "secondary"}>
                {credentialSummary.missing} missing
              </Badge>
              <Badge variant={credentialSummary.unsupported > 0 ? "warning" : "secondary"}>
                {credentialSummary.unsupported} unsupported
              </Badge>
            </div>
            <ul className="max-h-32 space-y-1 overflow-auto rounded-lg border border-border/60 p-2">
              {credentialResolutions.map((resolution) => (
                <li
                  key={`${resolution.credentialRef.kind}:${resolution.credentialRef.id}`}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
                >
                  <span className="min-w-0 truncate font-mono text-xs">
                    {resolution.credentialRef.kind}:{resolution.credentialRef.id}
                  </span>
                  <Badge variant={resolution.status === "resolved" ? "success" : "warning"}>
                    {resolution.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Credential check has not run.</p>
        )}
      </section>
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Prepared enablement</h3>
          <p className="text-xs text-muted-foreground">
            Choose what this import should enable. These switches only update the dry-run plan.
          </p>
        </div>
        {enablementEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No configurable entries in this bundle.</p>
        ) : (
          <ul className="max-h-56 space-y-1 overflow-auto rounded-lg border border-border/60 p-2">
            {enablementEntries.map((entry) => (
              <li
                key={`${entry.target.component}:${entry.target.id}`}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/30"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">{entry.label}</span>
                  <span className="block text-xs text-muted-foreground">{entry.detail}</span>
                </span>
                <Switch
                  size="sm"
                  checked={entry.enabled}
                  aria-label={`${entry.label} enabled in prepared Environment Bundle`}
                  onCheckedChange={(checked) =>
                    onIncomingChange(
                      setEnvironmentBundleEntryEnabled(incoming, entry.target, Boolean(checked)),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
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
      {authoritativePlanPending ? (
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
          Validating the destination and current provider snapshots…
        </div>
      ) : authoritativePlanError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive-foreground">
          {authoritativePlanError}
        </div>
      ) : applyMode === "authoritative" && authoritativePlan ? (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-muted-foreground">
          This plan can atomically apply {authoritativePlan.operations.length} verified environment
          change
          {authoritativePlan.operations.length === 1 ? "" : "s"}. The server will recheck the
          destination hash, refresh every affected provider, and roll back unless every requested
          state passes its post-write verification.
        </div>
      ) : applyMode === "settings" ? (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-muted-foreground">
          This settings-only path can atomically update the capability profile and supported legacy
          settings. Provider, MCP, skill, and plugin/app project policy changes use the
          authoritative server plan above; plugin/app policy never uninstalls the local plugin.
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
          <p>Application is blocked until every requested component has a safe destination.</p>
          <ul className="list-disc space-y-1 pl-4">
            {applyReadiness.blockers.slice(0, 8).map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
            {applyReadiness.blockers.length > 8 ? (
              <li>{applyReadiness.blockers.length - 8} more blockers</li>
            ) : null}
            {authoritativePlan?.blockers
              .filter((blocker) => !applyReadiness.blockers.includes(blocker))
              .slice(0, Math.max(0, 8 - applyReadiness.blockers.length))
              .map((blocker) => (
                <li key={`server:${blocker}`}>{blocker}</li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EnvironmentBundleImportDialog({
  current,
  environmentId,
  onOpenChange,
  onApplySettings,
  providerInstances,
  providers,
}: {
  current: EnvironmentBundle;
  environmentId: EnvironmentId;
  onOpenChange: (open: boolean) => void;
  onApplySettings: (patch: ServerSettingsPatch) => void;
  providerInstances: ServerSettings["providerInstances"];
  providers: ServerSettings["providers"];
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState(() => serializeEnvironmentBundle(current));
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [error, setError] = useState<string | null>(null);
  const [reviewBundle, setReviewBundle] = useState<EnvironmentBundle | null>(null);
  const [credentialResolutions, setCredentialResolutions] =
    useState<EnvironmentBundleCredentialResolutions | null>(null);
  const [credentialResolutionError, setCredentialResolutionError] = useState<string | null>(null);
  const [credentialResolutionPending, setCredentialResolutionPending] = useState(false);
  const credentialResolutionRequest = useRef(0);
  const [authoritativePlan, setAuthoritativePlan] = useState<EnvironmentBundleApplyPlan | null>(
    null,
  );
  const [authoritativePlanError, setAuthoritativePlanError] = useState<string | null>(null);
  const [authoritativePlanPending, setAuthoritativePlanPending] = useState(false);
  const [applyPending, setApplyPending] = useState(false);
  const applyPlanRequest = useRef(0);
  const resolveCredentials = useAtomCommand(serverEnvironment.resolveEnvironmentBundleCredentials, {
    reportFailure: false,
  });
  const planEnvironmentBundleApply = useAtomCommand(serverEnvironment.planEnvironmentBundleApply, {
    reportFailure: false,
  });
  const applyEnvironmentBundle = useAtomCommand(serverEnvironment.applyEnvironmentBundle);
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
  const applyReadiness = reviewBundle
    ? getEnvironmentBundleApplyReadiness(current, reviewBundle, {
        providerInstances,
        providers,
        ...(credentialResolutions ? { credentialResolutions } : {}),
      })
    : null;
  const applyMode = applyReadiness
    ? environmentBundleApplyMode(applyReadiness, authoritativePlan)
    : "blocked";
  const requestAuthoritativePlan = (incoming: EnvironmentBundle) => {
    const requestId = ++applyPlanRequest.current;
    setAuthoritativePlan(null);
    setAuthoritativePlanError(null);
    setAuthoritativePlanPending(true);
    void planEnvironmentBundleApply({
      environmentId,
      input: { current, incoming },
    }).then((result) => {
      if (requestId !== applyPlanRequest.current) return;
      setAuthoritativePlanPending(false);
      if (result._tag === "Success") {
        setAuthoritativePlan(result.value);
        return;
      }
      setAuthoritativePlanError(
        "Could not validate the Environment Bundle destination. No changes were applied.",
      );
    });
  };

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
          ) : reviewBundle ? (
            <EnvironmentBundleReview
              authoritativePlan={authoritativePlan}
              authoritativePlanError={authoritativePlanError}
              authoritativePlanPending={authoritativePlanPending}
              credentialResolutions={credentialResolutions}
              credentialResolutionError={credentialResolutionError}
              credentialResolutionPending={credentialResolutionPending}
              current={current}
              incoming={reviewBundle}
              onIncomingChange={(incoming) => {
                setReviewBundle(incoming);
                requestAuthoritativePlan(incoming);
              }}
              providerInstances={providerInstances}
              providers={providers}
            />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {step === "review" ? "Close review" : "Cancel"}
          </Button>
          {step === "review" ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  if (reviewBundle) setJson(serializeEnvironmentBundle(reviewBundle));
                  setStep("edit");
                }}
              >
                Back
              </Button>
              <Button onClick={() => reviewBundle && downloadBundle(reviewBundle)}>
                <DownloadIcon /> Export prepared bundle
              </Button>
              <Button
                disabled={
                  !reviewBundle ||
                  applyPending ||
                  authoritativePlanPending ||
                  applyMode === "blocked"
                }
                onClick={() => {
                  if (!reviewBundle || applyPending) return;
                  if (applyMode === "authoritative" && authoritativePlan) {
                    setApplyPending(true);
                    setAuthoritativePlanError(null);
                    void applyEnvironmentBundle({
                      environmentId,
                      input: { current, incoming: reviewBundle, expectedPlan: authoritativePlan },
                    }).then((result) => {
                      setApplyPending(false);
                      if (result._tag === "Success") {
                        onOpenChange(false);
                        return;
                      }
                      setAuthoritativePlanError(
                        "The Environment Bundle was not applied. Generate a fresh dry run and review the destination again.",
                      );
                      requestAuthoritativePlan(reviewBundle);
                    });
                    return;
                  }
                  if (applyMode === "settings") {
                    onApplySettings(
                      buildEnvironmentBundleSettingsPatch(current, reviewBundle, {
                        providerInstances,
                        providers,
                        ...(credentialResolutions ? { credentialResolutions } : {}),
                      }),
                    );
                    onOpenChange(false);
                  }
                }}
              >
                {applyPending ? "Applying and verifying…" : "Apply supported settings"}
              </Button>
            </>
          ) : (
            <Button
              onClick={() => {
                if (!parsed.bundle) {
                  setError(parsed.error ?? "Invalid Environment Bundle JSON.");
                  return;
                }
                setError(null);
                setReviewBundle(parsed.bundle);
                setStep("review");
                requestAuthoritativePlan(parsed.bundle);
                const credentialRefs = collectEnvironmentBundleCredentialReferences(parsed.bundle);
                const requestId = ++credentialResolutionRequest.current;
                setCredentialResolutionError(null);
                if (credentialRefs.length === 0) {
                  setCredentialResolutionPending(false);
                  setCredentialResolutions([]);
                  return;
                }
                setCredentialResolutions(null);
                setCredentialResolutionPending(true);
                void resolveCredentials({
                  environmentId,
                  input: { credentialRefs },
                }).then((result) => {
                  if (requestId !== credentialResolutionRequest.current) return;
                  setCredentialResolutionPending(false);
                  if (result._tag === "Success") {
                    setCredentialResolutions(result.value);
                    return;
                  }
                  setCredentialResolutionError(
                    "Could not check local credential references. Applying credential-dependent capabilities remains blocked.",
                  );
                });
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
  const providerInstances = useScopedSettings((settings) => settings.providerInstances);
  const providers = useScopedSettings((settings) => settings.providers);
  const mixed = useScopedSettingsMixed(["capabilityProfile"]);
  const updateSettings = useUpdateScopedSettings();
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
      {importOpen && bundle && target ? (
        <EnvironmentBundleImportDialog
          current={bundle}
          environmentId={target.environmentId}
          onOpenChange={setImportOpen}
          onApplySettings={updateSettings}
          providerInstances={providerInstances}
          providers={providers}
        />
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
