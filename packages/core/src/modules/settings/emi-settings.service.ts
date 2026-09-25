// EMI plans (Settings -> Payments -> EMI): the `emi` document in the decimal
// HTTP contract. Informational only: the product page says "EMI on card
// payment, from X/month"; checkout promises no EMI until a gateway supports it.
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { bpsToPercent, fromMinor, percentToBps } from "@scalius/shared/money";
import { emiSettingsSchema, type EmiSettings } from "@scalius/shared/emi";
import { emiDocument } from "./documents";
import { readStoreCurrency, toStoreMinor } from "./store-money";

export interface EmiPlanInput {
  id: string;
  provider: string;
  months: number;
  /** The bank's total conversion fee over the tenure, in percent (3 = 3%). */
  feePercentage: number;
  /** The smallest price the plan applies to, in major units (whole taka in BDT). */
  minAmount: number;
}

export interface EmiSettingsInput {
  enabled: boolean;
  plans: EmiPlanInput[];
}

function presentEmiSettings(value: EmiSettings, decimalPlaces: number): EmiSettingsInput {
  return {
    enabled: value.enabled,
    plans: value.plans.map((plan) => ({
      id: plan.id,
      provider: plan.provider,
      months: plan.months,
      feePercentage: bpsToPercent(plan.feeBps),
      minAmount: fromMinor(plan.minAmountMinor, decimalPlaces),
    })),
  };
}

export async function getEmiSettings(db: Database): Promise<EmiSettingsInput & { revision: number }> {
  const [{ value, revision }, currency] = await Promise.all([emiDocument.readDetailed(db), readStoreCurrency(db)]);
  return { ...presentEmiSettings(value, currency.decimalPlaces), revision };
}

/** Replaces the plans (compare-and-swap on the revision the editor loaded). */
export async function saveEmiSettings(
  db: Database,
  input: EmiSettingsInput,
  expectedRevision: number,
): Promise<EmiSettingsInput & { revision: number }> {
  const currency = await readStoreCurrency(db);
  const next = emiSettingsSchema.safeParse({
    enabled: input.enabled,
    plans: input.plans.map((plan) => ({
      id: plan.id,
      provider: plan.provider,
      months: plan.months,
      feeBps: plan.feePercentage === 0 ? 0 : percentToBps(plan.feePercentage),
      minAmountMinor: toStoreMinor(plan.minAmount, currency),
    })),
  });
  if (!next.success) {
    const issue = next.error.issues[0];
    throw new ValidationError(issue?.message ?? "EMI plans are invalid.", { field: issue?.path.join(".") || "plans" });
  }
  const { value, revision } = await emiDocument.write(db, next.data, {}, { expectedRevision, replace: true });
  return { ...presentEmiSettings(value, currency.decimalPlaces), revision };
}
