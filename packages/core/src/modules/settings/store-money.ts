import type { Database } from "@scalius/database/client";
import { toCashMinor, WholeCashAmountError } from "@scalius/shared/money";
import { ValidationError } from "@scalius/core/errors";
import { getCurrencyConfig } from "./settings.service";

/** The store currency as money writes need it. */
export interface StoreCurrency {
    code: string;
    decimalPlaces: number;
}

export async function readStoreCurrency(db: Database): Promise<StoreCurrency> {
    const { code, decimalPlaces } = await getCurrencyConfig(db);
    return { code, decimalPlaces };
}

/**
 * Every merchant-entered amount (price, compare-at, fixed discount, delivery
 * charge, threshold, refund, manual adjustment) goes through here: decimal
 * major units to minor units, and in BDT only whole taka ("Taka amounts are
 * whole numbers."). Other currencies keep minor units.
 */
export function toStoreMinor(amount: number, currency: StoreCurrency): number {
    try {
        return toCashMinor(amount, currency.decimalPlaces, currency.code);
    } catch (error) {
        if (error instanceof WholeCashAmountError) throw new ValidationError(error.message);
        throw error;
    }
}
