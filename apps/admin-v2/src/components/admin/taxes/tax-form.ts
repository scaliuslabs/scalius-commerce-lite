import type {
  TaxJurisdictionOption,
  TaxJurisdictionType,
  UpdateTaxSettingsInput,
} from "@/lib/api-functions/taxes";

export function basisPointsToPercent(rateBps: number): string {
  if (!Number.isInteger(rateBps) || rateBps < 0) return "0";
  return (rateBps / 100).toFixed(2).replace(/\.00$/, "");
}

export function percentToBasisPoints(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const percent = Number(normalized);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent * 100);
}

export function taxSettingsIssue(
  input: Pick<
    UpdateTaxSettingsInput,
    "enabled" | "taxShipping" | "defaultTaxClassId" | "shippingTaxClassId" | "displayLabel"
  >,
): string | null {
  if (!input.displayLabel.trim()) return "Enter the buyer-facing tax label.";
  if (input.enabled && !input.defaultTaxClassId) {
    return "Choose a default tax class before enabling tax.";
  }
  if (input.taxShipping && !input.shippingTaxClassId && !input.defaultTaxClassId) {
    return "Choose a shipping or default class before taxing shipping.";
  }
  return null;
}

export function resolveJurisdictionSelection(
  type: TaxJurisdictionType,
  optionId: string,
  options: readonly TaxJurisdictionOption[],
): { jurisdictionId: string | null; jurisdictionLabel: string | null } | null {
  if (type === "all") {
    return { jurisdictionId: null, jurisdictionLabel: null };
  }
  const option = options.find(
    (candidate) => candidate.type === type && candidate.id === optionId,
  );
  return option
    ? { jurisdictionId: option.id, jurisdictionLabel: option.name }
    : null;
}

export function formatTaxMoney(
  amount: number,
  currencyCode: string,
  locale = "en-BD",
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(amount);
}
