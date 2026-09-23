import type {
  TaxConfigurationPayload,
  TaxJurisdictionOption,
  TaxJurisdictionType,
  TaxRateRecord,
  TaxSettingsRecord,
} from "~/lib/api-query-options/taxes";

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

export type TaxSettingsIssue =
  | { field: "label"; key: "labelRequired" }
  | { field: "default"; key: "defaultRequired" | "groupMissing" }
  | { field: "delivery"; key: "deliveryRequired" | "groupMissing" }
  | { field: "default" | "delivery"; key: "groupNeedsRate"; name: string };

type SettingsDraft = Pick<
  TaxSettingsRecord,
  "enabled" | "taxShipping" | "defaultTaxClassId" | "shippingTaxClassId" | "displayLabel"
>;
type ClassesAndRates = Pick<TaxConfigurationPayload, "classes" | "rates">;

function hasActiveRate(configuration: ClassesAndRates, classId: string): boolean {
  return configuration.rates.some((rate) => rate.isActive && rate.taxClassId === classId);
}

/**
 * Mirrors the server's save checks so an unsafe tax setup can't be saved:
 * collecting tax needs a default group, and every taxed group needs a rate.
 */
export function taxSettingsIssue(
  input: SettingsDraft,
  configuration: ClassesAndRates,
): TaxSettingsIssue | null {
  if (!input.displayLabel.trim()) return { field: "label", key: "labelRequired" };
  const find = (id: string | null) => configuration.classes.find((taxClass) => taxClass.id === id);
  if (input.defaultTaxClassId && !find(input.defaultTaxClassId)) {
    return { field: "default", key: "groupMissing" };
  }
  // The delivery group is saved (and checked) only while delivery is taxed.
  if (input.taxShipping && input.shippingTaxClassId && !find(input.shippingTaxClassId)) {
    return { field: "delivery", key: "groupMissing" };
  }
  if (input.enabled && !input.defaultTaxClassId) return { field: "default", key: "defaultRequired" };
  if (input.taxShipping && !input.shippingTaxClassId && !input.defaultTaxClassId) {
    return { field: "delivery", key: "deliveryRequired" };
  }
  if (!input.enabled || !input.defaultTaxClassId) return null;

  const defaultClass = find(input.defaultTaxClassId)!;
  if (!defaultClass.isExempt && !hasActiveRate(configuration, defaultClass.id)) {
    return { field: "default", key: "groupNeedsRate", name: defaultClass.name };
  }
  const deliveryClass = input.taxShipping ? find(input.shippingTaxClassId ?? defaultClass.id)! : null;
  if (deliveryClass && deliveryClass.id !== defaultClass.id && !deliveryClass.isExempt
    && !hasActiveRate(configuration, deliveryClass.id)) {
    return { field: "delivery", key: "groupNeedsRate", name: deliveryClass.name };
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

export type RequiredTaxRateRole = "products" | "delivery";

/**
 * While tax is collected, the last active rate of the default or delivery
 * group can't be turned off, moved or deleted (the server refuses it too).
 */
export function getRequiredTaxRateRoles(
  configuration: TaxConfigurationPayload,
  rate: TaxRateRecord | null,
): RequiredTaxRateRole[] {
  if (!configuration.settings.enabled || !rate?.isActive) return [];

  const taxClass = configuration.classes.find(
    (candidate) => candidate.id === rate.taxClassId,
  );
  if (!taxClass || taxClass.isExempt) return [];

  const activeClassRates = configuration.rates.filter(
    (candidate) => candidate.isActive && candidate.taxClassId === rate.taxClassId,
  );
  if (activeClassRates.length !== 1 || activeClassRates[0]?.id !== rate.id) return [];

  const roles: RequiredTaxRateRole[] = [];
  if (configuration.settings.defaultTaxClassId === rate.taxClassId) roles.push("products");
  const deliveryClassId = configuration.settings.taxShipping
    ? configuration.settings.shippingTaxClassId ?? configuration.settings.defaultTaxClassId
    : null;
  if (deliveryClassId === rate.taxClassId) roles.push("delivery");
  return roles;
}
