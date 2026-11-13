// The ISO currency of every amount an approval summary shows: the store's,
// and for a change in an order's or a market's currency (a refund, a payment,
// a price-list price) the code of that order or price list's market, read
// when the summary is written so the owner never reads "order currency".
import { eq } from "drizzle-orm";
import { getDb } from "@scalius/database/client";
import { markets, orders, priceLists } from "@scalius/database/schema";
import type { ConfirmStep } from "./mcp/confirm";
import type { SummaryCurrencies } from "./mcp/confirm-summary";

function idFor(step: ConfirmStep, segment: RegExp): string | null {
  const parts = step.operation.pathTemplate.split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    const name = /^\{([^}]+)\}$/.exec(parts[index]!)?.[1];
    if (name && segment.test(parts[index - 1]!)) {
      const value = step.input.path?.[name];
      if (typeof value === "string" || typeof value === "number") return String(value);
    }
  }
  return null;
}

export async function summaryCurrencies(env: Env, steps: readonly ConfirmStep[]): Promise<SummaryCurrencies> {
  const db = getDb(env);
  let store: string | undefined;
  try {
    const { readStoreCurrency } = await import("@scalius/core/modules/markets");
    store = (await readStoreCurrency(db)).code;
  } catch {
    store = undefined;
  }
  const byOperation: Record<string, string> = {};
  for (const step of steps) {
    try {
      const body = step.input.body as { orderId?: unknown } | undefined;
      const orderId = idFor(step, /^orders$/) ?? (typeof body?.orderId === "string" ? body.orderId : null);
      if (orderId) {
        const order = await db.select({ code: orders.currencyCode }).from(orders).where(eq(orders.id, orderId)).get();
        if (order?.code) byOperation[step.operation.operationId] = order.code;
        continue;
      }
      const listId = idFor(step, /^price-lists$|^price_lists$/);
      if (listId) {
        const list = await db.select({ code: markets.currencyCode }).from(priceLists)
          .innerJoin(markets, eq(markets.id, priceLists.marketId)).where(eq(priceLists.id, listId)).get();
        if (list) byOperation[step.operation.operationId] = list.code ?? store ?? "";
      }
    } catch {
      // An unread currency shows as unknown, never as a guess.
    }
  }
  return { ...(store ? { store } : {}), byOperation };
}
