// src/lib/currency.ts
// Server-side currency utilities.
// Reads from the settings table or KV cache.

import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface CurrencyConfig {
  code: string;
  symbol: string;
  usdExchangeRate: number;
}

const DEFAULT_CURRENCY: CurrencyConfig = {
  code: "BDT",
  symbol: "\u09F3",
  usdExchangeRate: 1,
};

/**
 * Fetches currency settings from DB.
 * Uses KV cache if available.
 */
export async function getCurrencyConfig(
  db: any,
  kv?: KVNamespace | null,
): Promise<CurrencyConfig> {
  // Try KV cache first
  if (kv) {
    try {
      const cached = await kv.get("gw:currency");
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {}
  }

  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(eq(settings.category, "currency"))
      .all();

    const map = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    const config: CurrencyConfig = {
      code: map.currency_code ?? DEFAULT_CURRENCY.code,
      symbol: map.currency_symbol ?? DEFAULT_CURRENCY.symbol,
      usdExchangeRate: map.usd_exchange_rate
        ? parseFloat(map.usd_exchange_rate)
        : DEFAULT_CURRENCY.usdExchangeRate,
    };

    // Cache in KV for 5 minutes
    if (kv) {
      try {
        await kv.put("gw:currency", JSON.stringify(config), { expirationTtl: 300 });
      } catch {}
    }

    return config;
  } catch {
    return DEFAULT_CURRENCY;
  }
}
