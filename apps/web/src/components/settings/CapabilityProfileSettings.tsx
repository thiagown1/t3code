import type { PortableCapabilityDeclaration, PortableCapabilityProfile } from "@t3tools/contracts";
import {
  diffCapabilityProfiles,
  parseCapabilityProfileJson,
  serializeCapabilityProfile,
} from "@t3tools/shared/capabilityProfile";
import { DownloadIcon, FileJsonIcon, UploadIcon } from "lucide-react";
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
import { toastManager } from "../ui/toast";
import {
  capabilityProfileDownloadName,
  describeCapabilityProfileDiff,
  emptyCapabilityProfileForImport,
} from "./CapabilityProfileSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MAX_CAPABILITY_PROFILE_BYTES = 256 * 1024;

function downloadProfile(profile: PortableCapabilityProfile): void {
  const url = URL.createObjectURL(
    new Blob([serializeCapabilityProfile(profile)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = capabilityProfileDownloadName(profile);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function declarationLabel(declaration: PortableCapabilityDeclaration): string {
  const scope = declaration.scope
    ? Object.entries(declaration.scope)
        .map(([key, value]) => `${key}:${value}`)
        .join(", ")
    : "all scopes";
  return `${declaration.capabilityId} · ${scope}`;
}

function CapabilityDiffList({
  current,
  incoming,
}: {
  current: PortableCapabilityProfile | null;
  incoming: PortableCapabilityProfile;
}) {
  const empty = emptyCapabilityProfileForImport(incoming.name);
  const diff = diffCapabilityProfiles(current ?? empty, incoming);
  const summary = describeCapabilityProfileDiff(current, incoming);
  const unchanged = summary.added + summary.changed + summary.removed === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" aria-label="Capability profile changes">
        <Badge variant="success">{summary.added} added</Badge>
        <Badge variant="warning">{summary.changed} changed</Badge>
        <Badge variant="error">{summary.removed} removed</Badge>
      </div>
      <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
        <p className="font-medium text-foreground">{incoming.name}</p>
        <p className="mt-1 text-muted-foreground">
          Profile ID {incoming.profileId} · {incoming.capabilities.length} declarations
        </p>
      </div>
      {unchanged ? (
        <p className="text-sm text-muted-foreground">No declaration changes.</p>
      ) : (
        <ul className="max-h-56 space-y-2 overflow-auto text-xs">
          {diff.added.map((declaration) => (
            <li key={`added-${declarationLabel(declaration)}`} className="text-success-foreground">
              + {declarationLabel(declaration)} · {declaration.state}
            </li>
          ))}
          {diff.changed.map(({ before, after }) => (
            <li key={`changed-${declarationLabel(after)}`} className="text-warning-foreground">
              ~ {declarationLabel(after)} · {before.state} → {after.state}
            </li>
          ))}
          {diff.removed.map((declaration) => (
            <li
              key={`removed-${declarationLabel(declaration)}`}
              className="text-destructive-foreground"
            >
              − {declarationLabel(declaration)} · {declaration.state}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CapabilityProfileImportDialog({
  current,
  environmentLabel,
  targetCount,
  onOpenChange,
  onApply,
}: {
  current: PortableCapabilityProfile | null;
  environmentLabel: string;
  targetCount: number;
  onOpenChange: (open: boolean) => void;
  onApply: (profile: PortableCapabilityProfile) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState(() =>
    serializeCapabilityProfile(current ?? emptyCapabilityProfileForImport(environmentLabel)),
  );
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    try {
      return { profile: parseCapabilityProfileJson(json), error: null };
    } catch (cause) {
      return {
        profile: null,
        error: cause instanceof Error ? cause.message : "Invalid capability profile JSON.",
      };
    }
  }, [json]);

  const review = () => {
    if (!parsed.profile) {
      setError(parsed.error ?? "Invalid capability profile JSON.");
      return;
    }
    setError(null);
    setStep("review");
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {step === "edit" ? "Import capability profile" : "Review changes"}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {step === "edit"
              ? "Paste or choose a secret-free JSON profile. Nothing is saved until you review and confirm."
              : `This replaces the profile on ${targetCount === 1 ? environmentLabel : `${targetCount} selected environments`}.`}
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
                  if (file.size > MAX_CAPABILITY_PROFILE_BYTES) {
                    setError("Profile file is too large (maximum 256 KB). Nothing was read.");
                    return;
                  }
                  void file.text().then(setJson, () => setError("Could not read that file."));
                }}
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <FileJsonIcon /> Choose JSON file
              </Button>
              <Textarea
                aria-label="Capability profile JSON"
                className="font-mono text-xs"
                value={json}
                onChange={(event) => {
                  setJson(event.currentTarget.value);
                  setError(null);
                }}
                rows={14}
                spellCheck={false}
              />
              {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
              <p className="text-xs text-muted-foreground">
                Credential references contain only a manager kind and identifier. API keys,
                passwords, and tokens are ignored as unknown fields and are never exported.
              </p>
            </>
          ) : parsed.profile ? (
            <CapabilityDiffList current={current} incoming={parsed.profile} />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {step === "review" ? (
            <>
              <Button variant="outline" onClick={() => setStep("edit")}>
                Back
              </Button>
              <Button
                onClick={() => {
                  if (!parsed.profile) return;
                  onApply(parsed.profile);
                  onOpenChange(false);
                }}
              >
                Apply reviewed profile
              </Button>
            </>
          ) : (
            <Button onClick={review}>Review changes</Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CapabilityProfileSettings() {
  const profile = useScopedSettings((settings) => settings.capabilityProfile);
  const mixed = useScopedSettingsMixed(["capabilityProfile"]);
  const updateSettings = useUpdateScopedSettings();
  const { target, targets } = useSettingsScope();
  const [importOpen, setImportOpen] = useState(false);
  const environmentLabel = target?.label ?? "Environment";

  return (
    <SettingsSection id="capability-profile" title="Capabilities">
      <SettingsRow
        title="Environment capability profile"
        description="Portable feature policy for APIs, logs, Firebase, SSH, and other integrations. Secrets stay in each machine's credential manager."
        status={
          mixed
            ? "Mixed profiles across the selected environments"
            : profile
              ? `${profile.name} · ${profile.capabilities.length} declarations`
              : "Not configured · undeclared capabilities remain denied"
        }
        control={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={mixed || profile === null}
              onClick={() => {
                if (profile) downloadProfile(profile);
              }}
            >
              <DownloadIcon /> Export
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <UploadIcon /> Import
            </Button>
          </>
        }
        serverScoped
        settingKeys={["capabilityProfile"]}
        mixed={mixed}
      />
      {importOpen ? (
        <CapabilityProfileImportDialog
          current={mixed ? null : profile}
          environmentLabel={environmentLabel}
          targetCount={targets.length}
          onOpenChange={setImportOpen}
          onApply={(nextProfile) => {
            updateSettings({ capabilityProfile: nextProfile });
            toastManager.add({
              type: "success",
              title: "Capability profile saved",
              description: `${nextProfile.capabilities.length} declarations applied to ${targets.length === 1 ? environmentLabel : `${targets.length} environments`}.`,
            });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
