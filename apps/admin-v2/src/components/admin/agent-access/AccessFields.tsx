import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { SettingsField } from "~/components/admin/settings/SettingsPage";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";

import type { AgentGrantKind, AgentGrantSelection, AgentPreset, AgentResource } from "./types";

const PRESETS = ["read", "operator", "full"] as const;
const EXPIRY_DAYS = [7, 30, 90, 365] as const;

/** The API's lifetime limits: approvals 30 days, tools 90, keys 90 (365 view-only). */
function maxExpiryDays(kind: AgentGrantKind, preset: AgentPreset): number {
  if (kind === "oauth") return 30;
  if (kind === "cli") return 90;
  return preset === "read" ? 365 : 90;
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
}: {
  kind: AgentGrantKind;
  value: AgentGrantSelection;
  onChange: (value: AgentGrantSelection) => void;
  disabled?: boolean;
}) {
  const t = useMessages(aiAccessMessages);
  const max = maxExpiryDays(kind, value.preset);
  return (
    <>
      <fieldset className="space-y-1" disabled={disabled}>
        <legend className="text-body font-medium">{t("access")}</legend>
        <RadioGroup
          value={value.preset}
          onValueChange={(next) => {
            const preset = next as AgentPreset;
            onChange({
              ...value,
              preset,
              expiresInDays: Math.min(value.expiresInDays, maxExpiryDays(kind, preset)),
            });
          }}
        >
          {PRESETS.map((preset) => (
            <label key={preset} className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-body font-medium">
              <RadioGroupItem value={preset} className="mt-0.5" />
              <span className="space-y-0.5">
                <span className="block">{t(`preset_${preset}`)}</span>
                <span className="block font-normal text-muted-foreground">{t(`preset_${preset}Help`)}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {value.preset === "full" ? (
          <p role="alert" className="text-body text-destructive">{t("fullWarning")}</p>
        ) : null}
      </fieldset>
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
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="flex min-h-11 items-center gap-2 pr-10">
        <Link
          to="/admin/settings/apps"
          aria-label={t("backToApps")}
          className="-ml-2 grid size-11 place-items-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-5" aria-hidden="true" />
        </Link>
        <h1 className="text-heading-lg">{title}</h1>
      </div>
      {children}
    </div>
  );
}
