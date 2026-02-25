// src/pages/api/settings/currency.ts
// Admin API for currency settings.
// GET  - returns current currency settings
// POST - saves new settings to DB, invalidates KV cache

import type { APIRoute } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getKv } from "@/server/utils/kv-cache";
import { upsertSetting } from "@/lib/payment/gateway-settings";

const CATEGORY = "currency";

const KEYS = {
  currencyCode: "currency_code",
  currencySymbol: "currency_symbol",
  usdExchangeRate: "usd_exchange_rate",
} as const;

export const GET: APIRoute = async () => {
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(eq(settings.category, CATEGORY))
      .all();

    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    return Response.json({
      currencyCode: map[KEYS.currencyCode] ?? "BDT",
      currencySymbol: map[KEYS.currencySymbol] ?? "\u09F3",
      usdExchangeRate: map[KEYS.usdExchangeRate] ?? "1",
    });
  } catch (error) {
    console.error("Error fetching currency settings:", error);
    return Response.json({ message: "Error fetching currency settings" }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as {
      currencyCode?: string;
      currencySymbol?: string;
      usdExchangeRate?: string;
    };

    const ops: Promise<void>[] = [];

    if (typeof body.currencyCode === "string" && body.currencyCode.trim()) {
      ops.push(upsertSetting(db, CATEGORY, KEYS.currencyCode, body.currencyCode.trim()));
    }

    if (typeof body.currencySymbol === "string" && body.currencySymbol.trim()) {
      ops.push(upsertSetting(db, CATEGORY, KEYS.currencySymbol, body.currencySymbol.trim()));
    }

    if (typeof body.usdExchangeRate === "string" && body.usdExchangeRate.trim()) {
      const rate = parseFloat(body.usdExchangeRate.trim());
      if (!isNaN(rate) && rate > 0) {
        ops.push(upsertSetting(db, CATEGORY, KEYS.usdExchangeRate, String(rate)));
      }
    }

    await Promise.all(ops);

    // Invalidate KV cache so next request reads fresh settings.
    const kv = getKv();
    await kv?.delete("gw:currency");

    return Response.json({ message: "Currency settings saved successfully" });
  } catch (error) {
    console.error("Error saving currency settings:", error);
    return Response.json({ message: "Error saving currency settings" }, { status: 500 });
  }
};
