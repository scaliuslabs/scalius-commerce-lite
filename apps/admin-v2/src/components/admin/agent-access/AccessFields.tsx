import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Page } from "~/components/admin/resource/Page";

import { SettingsField } from "~/components/admin/settings/SettingsPage";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";

import type { AgentGrantKind, AgentGrantSelection, AgentPreset, AgentResource } from "./types";

// Custom access loads only when a merchant opens it.
const CustomAccessFields = lazy(() => import("./CustomAccessFields"));

const PRESETS = ["read", "operator", "full"] as const;
const EXPIRY_DAYS = [7, 30, 90, 365] as const;

/** The API's lifetime limits: approvals 30 days, tools 90, keys 90 (365 view-only, or a custom key that only looks). */
function maxExpiryDays(kind: AgentGrantKind, preset: AgentPreset, riskCeiling?: AgentGrantSelection["riskCeiling"]): number {
  if (kind === "oauth") return 30;
  if (kind === "cli") return 90;
  return preset === "read" || (preset === "custom" && riskCeiling === "read") ? 365 : 90;
}

/** What blocks creating the key: a custom key needs at least one permission. */
export function selectionProblem(selection: AgentGrantSelection): "permissionsRequired" | null {
  return selection.preset === "custom" && selection.permissions.length === 0 ? "permissionsRequired" : null;
}

/** Moving to Custom starts from nothing ticked, making changes, approvals on; leaving it drops those choices. */
function withPreset(kind: AgentGrantKind, value: AgentGrantSelection, preset: AgentPreset): AgentGrantSelection {
  const { riskCeiling: _risk, confirmPolicy: _confirm, ...rest } = value;
  const next: AgentGrantSelection = preset === "custom"
    ? { ...rest, preset, permissions: [], riskCeiling: "write", confirmPolicy: "destructive_financial" }
    : { ...rest, preset, permissions: value.preset === "custom" ? [] : value.permissions };
  return { ...next, expiresInDays: Math.min(value.expiresInDays, maxExpiryDays(kind, preset, next.riskCeiling)) };
}

/** View-only by default. `permissions` stays what the app asked for (empty = yours). */
export function defaultSelection(
  kind: AgentGrantKind,
  resource: AgentResource = "dashboard",
  permissions: string[] = [],
): AgentGrantSelection {
  return { resource, preset: "read", permissions, expiresInDays: kind === "pat" ? 90 : 30 };
}

/** Access level, where it works (keys only) and how long it lasts. */
export function AccessFields({
  kind,
  value,
  onChange,
  disabled = false,
  allowCustom = false,
}: {
  kind: AgentGrantKind;
  value: AgentGrantSelection;
  onChange: (value: AgentGrantSelection) => void;
  disabled?: boolean;
  /** Offer Custom access behind "More options" (new access keys). */
  allowCustom?: boolean;
}) {
  const t = useMessages(aiAccessMessages);
  const [moreOpen, setMoreOpen] = useState(value.preset === "custom");
  const max = maxExpiryDays(kind, value.preset, value.riskCeiling);
  return (
    <>
      <fieldset className="space-y-1" disabled={disabled}>
        <legend className="text-body font-medium">{t("access")}</legend>
        <RadioGroup
          value={value.preset}
          onValueChange={(next) => onChange(withPreset(kind, value, next as AgentPreset))}
        >
          {PRESETS.map((preset) => (
            <label key={preset} className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-body font-medium">
              <span className="flex h-lh items-center"><RadioGroupItem value={preset} aria-labelledby={`ai-access-${preset}-name`} aria-describedby={`ai-access-${preset}-help`}/></span>
              <span className="space-y-0.5">
                <span id={`ai-access-${preset}-name`} className="block">{t(`preset_${preset}`)}</span>
                <span id={`ai-access-${preset}-help`} className="block font-normal text-muted-foreground">{t(`preset_${preset}Help`)}</span>
              </span>
            </label>
          ))}
          {allowCustom && !(moreOpen || value.preset === "custom") ? (
            <button type="button" className="flex min-h-11 items-center text-body text-link hover:underline" onClick={() => { setMoreOpen(true); window.requestAnimationFrame(() => document.querySelector<HTMLElement>("#ai-access-custom [role=radio]")?.focus()); }}>
              {t("moreOptions")}
            </button>
          ) : null}
          {allowCustom && (moreOpen || value.preset === "custom") ? (
            <label id="ai-access-custom" className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-body font-medium">
              <span className="flex h-lh items-center"><RadioGroupItem value="custom" aria-labelledby="ai-access-custom-name" aria-describedby="ai-access-custom-help"/></span>
              <span className="space-y-0.5">
                <span id="ai-access-custom-name" className="block">{t("preset_custom")}</span>
                <span id="ai-access-custom-help" className="block font-normal text-muted-foreground">{t("preset_customHelp")}</span>
              </span>
            </label>
          ) : null}
        </RadioGroup>
        {value.preset === "full" ? (
          <p role="alert" className="text-body text-destructive">{t("fullWarning")}</p>
        ) : null}
      </fieldset>
      {allowCustom && value.preset === "custom" ? (
        <Suspense fallback={null}>
          <CustomAccessFields value={value} onChange={onChange} disabled={disabled} />
        </Suspense>
      ) : null}
      {kind === "pat" ? (
        <SettingsField id="ai-access-resource" label={t("worksWith")}>
          <SearchableSelect
            id="ai-access-resource"
            value={value.resource}
            disabled={disabled}
            onValueChange={(resource) => onChange({ ...value, resource: resource as AgentResource })}
            triggerClassName="w-full"
            options={[{ value: "dashboard", label: t("resource_dashboard") }, { value: "storefront", label: t("resource_storefront") }]}
          />
        </SettingsField>
      ) : null}
      <SettingsField id="ai-access-expiry" label={t("expiresAfter")}>
        <SearchableSelect
          id="ai-access-expiry"
          value={String(value.expiresInDays)}
          disabled={disabled}
          onValueChange={(days) => onChange({ ...value, expiresInDays: Number(days) })}
          triggerClassName="w-full"
          options={EXPIRY_DAYS.filter((days) => days <= max).map((days) => ({ value: String(days), label: days === 365 ? t("oneYear") : t("days", { count: days }) }))}
        />
      </SettingsField>
    </>
  );
}

/** Page frame for the approve/continue steps: back to Apps, a title, then content. */
export function AccessPage({ title, children }: { title: ReactNode; children: ReactNode }) {
  const t = useMessages(aiAccessMessages);
  return (
    <Page width="settings" className="space-y-4">
      <div className="flex min-h-11 items-center gap-2 pe-10">
        <Link
          to="/admin/settings/integrations"
          aria-label={t("backToIntegrations")}
          className="-ms-2 grid size-11 place-items-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-5" aria-hidden="true" />
        </Link>
        <h1 className="text-heading-lg">{title}</h1>
      </div>
      {children}
    </Page>
  );
}
