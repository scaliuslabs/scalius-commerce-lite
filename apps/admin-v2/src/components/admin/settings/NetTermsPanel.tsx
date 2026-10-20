// The invoice's own settings (pay later, net terms), under its row in the
// payment methods card and saved with it: the net days and who may pay by
// invoice (customer tags, segments, or an app's checkout decision). Guests
// never see it, so with nobody named it stays off.
import { useQuery } from "@tanstack/react-query";
import { NET_TERMS_DAYS, NET_TERMS_SEGMENTS_MAX, NET_TERMS_TAGS_MAX, type NetTermsSettings } from "@scalius/shared/payment-terms";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { customerSegmentsQueryOptions } from "~/lib/api-query-options/customers";
import { formatNumber, useMessages } from "~/i18n";
import { paymentsMessages } from "~/i18n/settings-payments";
import { SettingsField } from "./SettingsPage";

/** "wholesale, B2B " → ["wholesale", "b2b"]: Customers → Tags are lowercase. */
export function parseNetTermsTags(text: string): string[] {
  return [...new Set(text.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, NET_TERMS_TAGS_MAX);
}

export function NetTermsPanel({ value, disabled, onChange }: {
  value: NetTermsSettings;
  disabled: boolean;
  onChange: (next: NetTermsSettings) => void;
}) {
  const t = useMessages(paymentsMessages);
  const segments = useQuery(customerSegmentsQueryOptions());
  const segmentList = segments.data?.segments ?? [];
  const named = value.customerTags.length > 0 || value.segmentIds.length > 0 || value.appsDecide;
  const toggleSegment = (id: string, on: boolean) => onChange({
    ...value,
    segmentIds: on ? [...value.segmentIds, id].slice(0, NET_TERMS_SEGMENTS_MAX) : value.segmentIds.filter((item) => item !== id),
  });
  return (
    <div className="w-full space-y-4 rounded-md border border-border bg-muted/30 p-4" data-net-terms-panel>
      <SettingsField id="net-terms-days" label={t("netTermsDays")} help={t("netTermsDaysHelp")}>
        <SearchableSelect
          id="net-terms-days"
          triggerClassName="max-w-xs"
          value={String(value.dueInDays)}
          disabled={disabled}
          onValueChange={(days) => onChange({ ...value, dueInDays: Number(days) as NetTermsSettings["dueInDays"] })}
          options={NET_TERMS_DAYS.map((days) => ({ value: String(days), label: t("netDays", { days: formatNumber(days) }) }))}
        />
      </SettingsField>
      <SettingsField id="net-terms-tags" label={t("netTermsTags")} help={t("netTermsTagsHelp")}>
        <Input
          id="net-terms-tags"
          // Remounts when the saved tags change (a discard or a save), so it never shows stale text.
          key={value.customerTags.join(",")}
          defaultValue={value.customerTags.join(", ")}
          disabled={disabled}
          placeholder={t("netTermsTagsPlaceholder")}
          onBlur={(event) => onChange({ ...value, customerTags: parseNetTermsTags(event.currentTarget.value) })}
        />
      </SettingsField>
      <fieldset className="space-y-2">
        <legend className="text-body font-medium">{t("netTermsSegments")}</legend>
        {segments.isError ? (
          <p className="text-body text-muted-foreground">{t("netTermsSegmentsFailed")}</p>
        ) : segmentList.length === 0 ? (
          <p className="text-body text-muted-foreground">{segments.isPending ? t("netTermsSegmentsLoading") : t("netTermsNoSegments")}</p>
        ) : (
          <ul className="space-y-1">
            {segmentList.map((segment) => (
              <li key={segment.id}>
                <label className="flex min-h-11 items-center gap-3 text-body md:min-h-9">
                  <Checkbox
                    checked={value.segmentIds.includes(segment.id)}
                    disabled={disabled || (!value.segmentIds.includes(segment.id) && value.segmentIds.length >= NET_TERMS_SEGMENTS_MAX)}
                    onCheckedChange={(checked) => toggleSegment(segment.id, checked === true)}
                  />
                  {segment.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <label className="flex min-h-11 items-start justify-between gap-4">
        <span>
          <span className="block text-body font-medium">{t("netTermsApps")}</span>
          <span className="block text-body text-muted-foreground">{t("netTermsAppsHelp")}</span>
        </span>
        <Switch checked={value.appsDecide} disabled={disabled} onCheckedChange={(appsDecide) => onChange({ ...value, appsDecide })} />
      </label>
      {!named ? <p role="alert" className="text-body text-destructive">{t("netTermsNobody")}</p> : null}
    </div>
  );
}
