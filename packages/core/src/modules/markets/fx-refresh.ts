// Exchange rates from an app (MARKETS-DESIGN D5; docs/platform/PLUGINS.md,
// "Providers", fx). A market in its own currency whose `fx_rate_source` names
// an app FX provider gets its rate from the scheduled tick: one call per
// source and currency, the answer stored on the market with its time. Pages,
// carts and checkouts read the stored rate only, so a slow or failing
// provider never delays a buyer: the last rate stays until a new one comes.
//
// A new rate advances the market's pricing dependency through the market
// trigger (`fx_rate`), so cached prices follow it; the same rate again only
// moves `fx_rate_as_of`, which no cached read depends on.

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { safeBatch, type Database } from "@scalius/database/client";
import { markets } from "@scalius/database/schema";
import { MANUAL_FX_RATE_SOURCE_ID, type FxRateSource } from "@scalius/shared/market-pricing";
import { isFxRate } from "@scalius/shared/money-chain";
import { readStoreCurrency } from "./pricing";

export interface MarketFxRefreshResult {
  /** Markets whose rate an app sets. */
  markets: number;
  /** Markets whose stored rate changed. */
  changed: number;
  /** Markets whose source could not answer (they keep their last rate). */
  failed: number;
}

/**
 * Asks each market's app source for its rate and stores the answers.
 * `sourceOf` resolves a source id to a ready source, or null when the app is
 * not installed, not active or not configured (those markets keep their rate).
 * With no market on an app source this is one read of the markets table.
 */
export async function refreshMarketFxRates(
  db: Database,
  sourceOf: (sourceId: string) => Promise<FxRateSource | null>,
): Promise<MarketFxRefreshResult> {
  const rows = await db.select({
    id: markets.id,
    currencyCode: markets.currencyCode,
    fxRate: markets.fxRate,
    fxRateSource: markets.fxRateSource,
  }).from(markets)
    .where(and(ne(markets.fxRateSource, MANUAL_FX_RATE_SOURCE_ID), isNotNull(markets.currencyCode), eq(markets.isBackup, false)));
  const result: MarketFxRefreshResult = { markets: rows.length, changed: 0, failed: 0 };
  if (rows.length === 0) return result;
  const shop = (await readStoreCurrency(db)).code;
  const sources = new Map<string, Promise<FxRateSource | null>>();
  const writes: BatchItem<"sqlite">[] = [];
  for (const row of rows) {
    if (!row.currencyCode || row.currencyCode === shop) continue;
    let source = sources.get(row.fxRateSource);
    if (!source) {
      source = sourceOf(row.fxRateSource).catch(() => null);
      sources.set(row.fxRateSource, source);
    }
    const answer = await (await source)?.rate(shop, row.currencyCode).catch(() => null) ?? null;
    if (!answer || !isFxRate(answer.rate)) {
      result.failed += 1;
      continue;
    }
    if (answer.rate !== row.fxRate) result.changed += 1;
    const asOf = Math.floor((answer.asOf?.getTime() ?? Date.now()) / 1_000);
    // Only while the market still takes its rate from this source.
    writes.push(db.update(markets)
      .set({ fxRate: answer.rate, fxRateAsOf: asOf, updatedAt: sql`unixepoch()` })
      .where(and(eq(markets.id, row.id), eq(markets.fxRateSource, row.fxRateSource))) as unknown as BatchItem<"sqlite">);
  }
  if (writes.length > 0) await safeBatch(db, writes as never);
  return result;
}
