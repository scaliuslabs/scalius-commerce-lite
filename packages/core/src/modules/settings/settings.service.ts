// src/modules/settings/settings.service.ts
// Currency configuration: the shop currency, a store fact. Storage lives in
// ./documents; the price increment is the backup market's (markets domain).

import { getDecimalPlaces } from "@scalius/shared/currency";
import type { Database } from "@scalius/database/client";
import { currencyDocument } from "./documents";

// ─────────────────────────────────────────
// Currency
// ─────────────────────────────────────────

export interface CurrencyConfig {
    code: string;
    symbol: string;
    decimalPlaces: number;
}

export async function getCurrencyConfig(db: Database): Promise<CurrencyConfig> {
    const currency = await currencyDocument.read(db);
    return {
        code: currency.currencyCode,
        symbol: currency.currencySymbol,
        decimalPlaces: getDecimalPlaces(currency.currencyCode),
    };
}
