// src/modules/settings/settings.service.ts
// Currency configuration. Storage lives in ./documents.

import { getDecimalPlaces } from "@scalius/shared/currency";
import type { Database } from "@scalius/database/client";
import { currencyDocument, priceIncrementOf } from "./documents";

// ─────────────────────────────────────────
// Currency
// ─────────────────────────────────────────

export interface CurrencyConfig {
    code: string;
    symbol: string;
    decimalPlaces: number;
    /** The default market's price increment (`priceIncrementOf`). */
    priceIncrementMinor: number;
}

export async function getCurrencyConfig(db: Database): Promise<CurrencyConfig> {
    const currency = await currencyDocument.read(db);
    return {
        code: currency.currencyCode,
        symbol: currency.currencySymbol,
        decimalPlaces: getDecimalPlaces(currency.currencyCode),
        priceIncrementMinor: priceIncrementOf(currency),
    };
}
