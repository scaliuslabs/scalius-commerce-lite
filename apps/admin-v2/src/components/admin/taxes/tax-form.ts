import type {
  TaxJurisdictionOption,
  TaxJurisdictionType,
  TaxConfigurationPayload,
  TaxSettingsRecord,
  UpdateTaxSettingsInput,
} from "~/lib/api-functions/taxes";

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

export type TaxSettingsInput = Pick<
  UpdateTaxSettingsInput,
  "enabled" | "taxShipping" | "defaultTaxClassId" | "shippingTaxClassId" | "displayLabel"
>;

/**
 * Per-field validation for the settings form. The save bar blocks on any of
 * these, and each message renders under the field it belongs to.
 */
export interface TaxSettingsFieldIssues {
  displayLabel?: string;
  defaultTaxClassId?: string;
  shippingTaxClassId?: string;
}

/** Field order, and therefore the order a single summary message picks from. */
export const TAX_SETTINGS_ISSUE_FIELDS = [
  "displayLabel",
  "defaultTaxClassId",
  "shippingTaxClassId",
] as const satisfies readonly (keyof TaxSettingsFieldIssues)[];

/** The saved settings record as the editable draft the form starts from. */
export function buildTaxSettingsDraft(
  settings: TaxSettingsRecord,
): UpdateTaxSettingsInput {
  return {
    expectedVersion: settings.version,
    enabled: settings.enabled,
    pricesIncludeTax: settings.pricesIncludeTax,
    taxShipping: settings.taxShipping,
    defaultTaxClassId: settings.defaultTaxClassId,
    shippingTaxClassId: settings.shippingTaxClassId,
    displayLabel: settings.displayLabel,
  };
}

export function taxSettingsFieldIssues(
  input: TaxSettingsInput,
  configuration?: Pick<TaxConfigurationPayload, "classes" | "rates">,
): TaxSettingsFieldIssues {
  const issues: TaxSettingsFieldIssues = {};
  if (!input.displayLabel.trim()) {
    issues.displayLabel = "Enter the buyer-facing tax label.";
  }
  if (input.enabled && !input.defaultTaxClassId) {
    issues.defaultTaxClassId = "Choose a default tax class before enabling tax.";
  }
  if (input.taxShipping && !input.shippingTaxClassId && !input.defaultTaxClassId) {
    issues.shippingTaxClassId =
      "Choose a shipping or default class before taxing shipping.";
  }
  if (input.enabled && configuration && input.defaultTaxClassId) {
    const defaultClass = configuration.classes.find(
      (taxClass) => taxClass.id === input.defaultTaxClassId,
    );
    if (!defaultClass) {
      issues.defaultTaxClassId =
        "Choose an active default tax class before enabling tax.";
      return issues;
    }
    const defaultRateReady = defaultClass.isExempt || configuration.rates.some(
      (rate) => rate.isActive && rate.taxClassId === defaultClass.id,
    );
    if (!defaultRateReady) {
      issues.defaultTaxClassId = `Add an active rate to default product class “${defaultClass.name}” before enabling tax.`;
    }

    const effectiveShippingClassId = input.taxShipping
      ? input.shippingTaxClassId ?? input.defaultTaxClassId
      : null;
    if (effectiveShippingClassId && effectiveShippingClassId !== defaultClass.id) {
      const shippingClass = configuration.classes.find(
        (taxClass) => taxClass.id === effectiveShippingClassId,
      );
      if (!shippingClass) {
        issues.shippingTaxClassId =
          "Choose an active shipping tax class before enabling tax.";
        return issues;
      }
      const shippingRateReady = shippingClass.isExempt || configuration.rates.some(
        (rate) => rate.isActive && rate.taxClassId === shippingClass.id,
      );
      if (!shippingRateReady) {
        issues.shippingTaxClassId = `Add an active rate to shipping class “${shippingClass.name}” before enabling tax.`;
      }
    }
  }
  return issues;
}

/**
 * The first field issue, for the save bar summary. The full set stays
 * available through `taxSettingsFieldIssues` so each field can show its own.
 */
export function taxSettingsIssue(
  input: TaxSettingsInput,
  configuration?: Pick<TaxConfigurationPayload, "classes" | "rates">,
): string | null {
  const issues = taxSettingsFieldIssues(input, configuration);
  for (const field of TAX_SETTINGS_ISSUE_FIELDS) {
    const issue = issues[field];
    if (issue) return issue;
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

/**
 * What the contextual save bar shows for a settings draft. Keeping this pure
 * lets the save flow be asserted without mounting the router.
 */
export interface TaxSettingsSaveBarState {
  /** The bar only exists while the draft differs from the saved policy. */
  visible: boolean;
  /** False for a viewer without `taxes.manage`; both actions lock. */
  canSave: boolean;
  /** True while the draft would be rejected by the enabled-configuration rules. */
  saveDisabled: boolean;
  /** Why Save is unavailable, or null when it is available. */
  disabledReason: string | null;
}

export function taxSettingsSaveBarState(
  current: UpdateTaxSettingsInput,
  saved: UpdateTaxSettingsInput,
  configuration?: Pick<TaxConfigurationPayload, "classes" | "rates">,
  options: { canManage?: boolean } = {},
): TaxSettingsSaveBarState {
  const canSave = options.canManage !== false;
  const issue = taxSettingsIssue(current, configuration);
  return {
    visible: taxSettingsFormIsDirty(current, saved),
    canSave,
    saveDisabled: Boolean(issue),
    disabledReason: issue
      ?? (canSave ? null : "You do not have permission to manage taxes."),
  };
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
