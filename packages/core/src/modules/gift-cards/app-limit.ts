// The daily cap on the value an app adds to gift cards (security audit S2).
//
// An app holding `write_gift_cards` issues and tops up stored value the store
// owes, so what one app adds in a UTC day (cards it issues plus positive
// adjustments) is bounded by the merchant's `gift_cards.appDailyLimitMinor`
// setting, in minor units of the store currency. The running total is one
// small `system_kv` row per app and day, checked and advanced inside the
// issue or adjustment's own batch: the guard and the increment commit with the
// ledger row or not at all, so concurrent writes can never pass the limit.
// Staff and agents (confirmation-gated) are not capped.
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError } from "@scalius/database/client";
import { systemKv } from "@scalius/database/schema";
import { AppError } from "../../errors";

type Statement = BatchItem<"sqlite">;

const APP_GIFT_CARD_LIMIT_GUARD = "APP_GIFT_CARD_DAILY_LIMIT";
/** The refusal's code: the merchant's daily limit for apps would be passed. */
export const APP_GIFT_CARD_LIMIT_CODE = "app_gift_card_limit";

const DAY_SECONDS = 86_400;

/** The running total's row: one per app and UTC day. */
export function appGiftCardValueKey(pluginId: string, nowSeconds: number): string {
  const day = new Date(Math.floor(nowSeconds / DAY_SECONDS) * DAY_SECONDS * 1000).toISOString().slice(0, 10);
  return `gift-cards:app-value:${pluginId}:${day}`;
}

/**
 * The guard and the increment for `amountMinor` added by one app, to run in
 * the same batch as the ledger row that adds it. The batch fails with
 * `isAppGiftCardLimitError` when the day's total would pass `limitMinor`.
 */
export function buildAppGiftCardValueStatements(
  db: Database,
  input: { pluginId: string; amountMinor: number; limitMinor: number; nowSeconds?: number },
): Statement[] {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const key = appGiftCardValueKey(input.pluginId, now);
  // Kept a day past its own day, then swept with the other expired rows.
  const expiresAt = (Math.floor(now / DAY_SECONDS) + 2) * DAY_SECONDS;
  const used = sql`coalesce((SELECT CAST(${systemKv.value} AS BIGINT) FROM ${systemKv} WHERE ${systemKv.key} = ${key}), 0)`;
  return [
    buildBatchGuard(db, sql`${used} + ${input.amountMinor} <= ${input.limitMinor}`, APP_GIFT_CARD_LIMIT_GUARD) as Statement,
    db.insert(systemKv).values({ key, value: String(input.amountMinor), expiresAt })
      .onConflictDoUpdate({
        target: systemKv.key,
        set: { value: sql`CAST(CAST(${systemKv.value} AS BIGINT) + CAST(${input.amountMinor} AS BIGINT) AS TEXT)` },
      }) as unknown as Statement,
  ];
}

/** What one app has added today, in store-currency minor units. */
export async function readAppGiftCardValueToday(db: Database, pluginId: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<number> {
  const row = await db.select({ value: systemKv.value }).from(systemKv)
    .where(sql`${systemKv.key} = ${appGiftCardValueKey(pluginId, nowSeconds)}`).get();
  const value = Number(row?.value ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function isAppGiftCardLimitError(error: unknown): boolean {
  return isBatchGuardError(error, APP_GIFT_CARD_LIMIT_GUARD);
}

/** The refusal an app sees (403): its daily limit, in the store currency's minor units. */
export function appGiftCardLimitError(input: { limitMinor: number; usedMinor: number; currencyCode: string }): AppError {
  const message = input.limitMinor === 0
    ? "This store doesn't let apps add value to gift cards. The merchant can allow it in Gift cards > Settings."
    : "This would pass the most this store lets one app add to gift cards in a day. Try again tomorrow, or ask the merchant to raise the limit in Gift cards > Settings.";
  return new AppError(403, APP_GIFT_CARD_LIMIT_CODE, message, {
    limitMinor: input.limitMinor,
    usedTodayMinor: input.usedMinor,
    currency: input.currencyCode,
  });
}
