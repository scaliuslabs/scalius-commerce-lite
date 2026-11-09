// The warranty's one-line summary ("1 year brand warranty · 7-day
// replacement") and its dates, in the dashboard language.
import type { WarrantyLabelInput } from "@scalius/shared/warranty";
import { formatDateTime, useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";

type T = ReturnType<typeof useMessages<keyof typeof warrantyMessages.en>>;

/** "1 year", "18 months", "Lifetime". */
export function warrantyDuration(t: T, policy: Pick<WarrantyLabelInput, "durationValue" | "durationUnit">): string {
  const { durationValue: count, durationUnit: unit } = policy;
  if (unit === "lifetime") return t("duration.lifetime");
  return count === 1
    ? t(unit === "days" ? "duration.day" : unit === "months" ? "duration.month" : "duration.year")
    : t(`duration.${unit}`, { count: count ?? 0 });
}

export function warrantySummary(t: T, policy: WarrantyLabelInput): string {
  const duration = warrantyDuration(t, policy);
  const warranty = t(`summary.${policy.provider}`, { duration });
  return policy.replacementDays ? `${warranty} · ${t("summary.replacement", { days: policy.replacementDays })}` : warranty;
}

/** An ISO timestamp as a medium date in the store time zone. */
export function warrantyDate(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? formatDateTime(date, { dateStyle: "medium" }) : "";
}
