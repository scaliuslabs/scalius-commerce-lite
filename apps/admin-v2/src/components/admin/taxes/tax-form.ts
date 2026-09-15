import type {
  TaxJurisdictionOption,
  TaxJurisdictionType,
  TaxConfigurationPayload,
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
  configuration?: Pick<TaxConfigurationPayload, "classes" | "rates">,
): string | null {
  if (!input.displayLabel.trim()) return "Enter the buyer-facing tax label.";
  if (input.enabled && !input.defaultTaxClassId) {
    return "Choose a default tax class before enabling tax.";
  }
  if (input.taxShipping && !input.shippingTaxClassId && !input.defaultTaxClassId) {
    return "Choose a shipping or default class before taxing shipping.";
  }
  if (input.enabled && configuration && input.defaultTaxClassId) {
    const defaultClass = configuration.classes.find(
      (taxClass) => taxClass.id === input.defaultTaxClassId,
    );
    if (!defaultClass) return "Choose an active default tax class before enabling tax.";
    const defaultRateReady = defaultClass.isExempt || configuration.rates.some(
      (rate) => rate.isActive && rate.taxClassId === defaultClass.id,
    );
    if (!defaultRateReady) {
      return `Add an active rate to default product class “${defaultClass.name}” before enabling tax.`;
    }

    const effectiveShippingClassId = input.taxShipping
      ? input.shippingTaxClassId ?? input.defaultTaxClassId
      : null;
    if (effectiveShippingClassId && effectiveShippingClassId !== defaultClass.id) {
      const shippingClass = configuration.classes.find(
        (taxClass) => taxClass.id === effectiveShippingClassId,
      );
      if (!shippingClass) return "Choose an active shipping tax class before enabling tax.";
      const shippingRateReady = shippingClass.isExempt || configuration.rates.some(
        (rate) => rate.isActive && rate.taxClassId === shippingClass.id,
      );
      if (!shippingRateReady) {
        return `Add an active rate to shipping class “${shippingClass.name}” before enabling tax.`;
      }
    }
  }
  return null;
}

export function taxSettingsFormIsDirty(
  current: UpdateTaxSettingsInput,
  saved: UpdateTaxSettingsInput,
): boolean {
  return (
    current.expectedVersion !== saved.expectedVersion ||
    current.enabled !== saved.enabled ||
    current.pricesIncludeTax !== saved.pricesIncludeTax ||
    current.taxShipping !== saved.taxShipping ||
    current.defaultTaxClassId !== saved.defaultTaxClassId ||
    current.shippingTaxClassId !== saved.shippingTaxClassId ||
    current.displayLabel !== saved.displayLabel
  );
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
