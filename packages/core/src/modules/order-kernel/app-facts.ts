// What apps did to an order, kept as immutable facts in `order_events` (no
// schema of their own): `app_discount` rows are written in the checkout
// commit batch, one per app discount the order carries; `app_risk` rows are
// an app's advisory risk check, written after the order was placed. The
// timeline leaves both out: the order summary shows the discounts, the
// customer card shows the risk checks. Money is integer minor units.
import { nanoid } from "nanoid";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { chunkRowsForD1 } from "@scalius/database/client";
import { orderEvents, orders } from "@scalius/database/schema";
import type { AppliedAppDiscount, AppDiscountTarget } from "@scalius/shared/checkout-app-facts";
import { sha256Hex } from "@scalius/shared/hash";

export const ORDER_APP_FACT_KINDS = ["app_discount", "app_risk"] as const;
export type OrderAppFactKind = (typeof ORDER_APP_FACT_KINDS)[number];

/** An app discount as the order recorded it. */
export interface OrderAppDiscountFact {
  pluginId: string;
  appName: string;
  title: string;
  code: string | null;
  target: AppDiscountTarget;
  currencyCode: string;
  /** Off the items. */
  amountMinor: number;
  /** Off delivery. */
  shippingAmountMinor: number;
  lines: Array<{ orderItemId: string; amountMinor: number }>;
}

/** An app's advisory risk check of the order: shown to the merchant, never acted on. */
export interface OrderAppRiskCheck {
  pluginId: string;
  appName: string;
  level: "low" | "medium" | "high";
  reasons: string[];
  checkedAt: Date;
}

// id, order_id, kind, body, data, actor_id (created_at is a SQL literal).
const ORDER_EVENT_PARAMETERS_PER_ROW = 6;

/** The `app_discount` rows of a committing order (statements for its batch). */
export function buildAppDiscountFactInserts(
  db: Database,
  input: {
    orderId: string;
    currencyCode: string;
    discounts: readonly AppliedAppDiscount[];
    /** Tax allocation line id → order item id. */
    orderItemIdByLineId: ReadonlyMap<string, string>;
  },
) {
  const rows = input.discounts.map((discount) => {
    const fact: OrderAppDiscountFact = {
      pluginId: discount.pluginId,
      appName: discount.appName,
      title: discount.title,
      code: discount.code,
      target: discount.target,
      currencyCode: input.currencyCode,
      amountMinor: discount.amountMinor,
      shippingAmountMinor: discount.shippingAmountMinor,
      lines: discount.lines.map((line) => {
        const orderItemId = input.orderItemIdByLineId.get(line.lineId);
        if (!orderItemId) throw new RangeError("An app discount names a line the order does not have.");
        return { orderItemId, amountMinor: line.amountMinor };
      }),
    };
    return {
      id: `oev_app${nanoid(16)}`,
      orderId: input.orderId,
      kind: "app_discount" as const,
      body: null,
      data: JSON.stringify(fact),
      actorId: null,
      createdAt: sql`unixepoch()`,
    };
  });
  return chunkRowsForD1(rows, ORDER_EVENT_PARAMETERS_PER_ROW).map((chunk) => db.insert(orderEvents).values(chunk));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMinor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseAppDiscountFact(data: string | null): OrderAppDiscountFact | null {
  const value = parseJson(data);
  if (!isRecord(value)) return null;
  const amountMinor = safeMinor(value.amountMinor);
  const shippingAmountMinor = safeMinor(value.shippingAmountMinor);
  const target = value.target;
  if (
    typeof value.pluginId !== "string" || typeof value.appName !== "string" || typeof value.title !== "string"
    || typeof value.currencyCode !== "string" || amountMinor === null || shippingAmountMinor === null
    || (target !== "order" && target !== "lines" && target !== "shipping") || !Array.isArray(value.lines)
  ) return null;
  const lines: OrderAppDiscountFact["lines"] = [];
  for (const line of value.lines) {
    const lineAmount = isRecord(line) ? safeMinor(line.amountMinor) : null;
    if (!isRecord(line) || typeof line.orderItemId !== "string" || lineAmount === null) return null;
    lines.push({ orderItemId: line.orderItemId, amountMinor: lineAmount });
  }
  return {
    pluginId: value.pluginId,
    appName: value.appName,
    title: value.title,
    code: typeof value.code === "string" ? value.code : null,
    target,
    currencyCode: value.currencyCode,
    amountMinor,
    shippingAmountMinor,
    lines,
  };
}

function parseAppRiskCheck(data: string | null, createdAt: number): OrderAppRiskCheck | null {
  const value = parseJson(data);
  if (!isRecord(value)) return null;
  const level = value.level;
  if (
    typeof value.pluginId !== "string" || typeof value.appName !== "string"
    || (level !== "low" && level !== "medium" && level !== "high") || !Array.isArray(value.reasons)
  ) return null;
  return {
    pluginId: value.pluginId,
    appName: value.appName,
    level,
    reasons: value.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 5),
    checkedAt: new Date(Number(createdAt) * 1000),
  };
}

/** The `app_discount` / `app_risk` rows of orders (one statement; batchable). */
export function selectOrderAppFactRows(db: Database, orderIds: readonly string[], kinds: readonly OrderAppFactKind[] = ORDER_APP_FACT_KINDS) {
  return db.select({ orderId: orderEvents.orderId, kind: orderEvents.kind, data: orderEvents.data, createdAt: orderEvents.createdAt })
    .from(orderEvents)
    .where(and(
      orderIds.length === 1 ? eq(orderEvents.orderId, orderIds[0]!) : inArray(orderEvents.orderId, [...orderIds]),
      inArray(orderEvents.kind, [...kinds]),
    ))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
}

export type OrderAppFactRow = { orderId: string; kind: string; data: string | null; createdAt: number };

export function resolveOrderAppFacts(rows: readonly OrderAppFactRow[]): { discounts: OrderAppDiscountFact[]; riskChecks: OrderAppRiskCheck[] } {
  const discounts: OrderAppDiscountFact[] = [];
  const riskChecks: OrderAppRiskCheck[] = [];
  for (const row of rows) {
    if (row.kind === "app_discount") {
      const fact = parseAppDiscountFact(row.data);
      if (fact) discounts.push(fact);
    } else if (row.kind === "app_risk") {
      const check = parseAppRiskCheck(row.data, row.createdAt);
      if (check) riskChecks.push(check);
    }
  }
  // Newest risk check first; discounts in the order they applied.
  riskChecks.sort((left, right) => right.checkedAt.getTime() - left.checkedAt.getTime() || left.pluginId.localeCompare(right.pluginId));
  return { discounts, riskChecks };
}

export async function listOrderAppFacts(db: Database, orderId: string) {
  return resolveOrderAppFacts(await selectOrderAppFactRows(db, [orderId]).all() as OrderAppFactRow[]);
}

/**
 * The buyer's earlier orders, counts only (`ctx.orders.riskHistory`): orders
 * filed under the same customer record (a guest's phone record) or the same
 * account. Orders that never became sales (incomplete online payments) are
 * left out; a returned order counts as returned to sender.
 */
export async function readOrderRiskHistory(
  db: Database,
  input: { orderId: string; customerId: string | null; accountOwnerCustomerId: string | null },
): Promise<{ orders: number; cancelled: number; returnedToSender: number }> {
  const owners = [input.customerId, input.accountOwnerCustomerId].filter((id): id is string => Boolean(id));
  if (owners.length === 0) return { orders: 0, cancelled: 0, returnedToSender: 0 };
  const row = await db.select({
    orders: sql<number>`COUNT(*)`,
    cancelled: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'cancelled' THEN 1 ELSE 0 END), 0)`,
    returnedToSender: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'returned' THEN 1 ELSE 0 END), 0)`,
  }).from(orders).where(and(
    ne(orders.id, input.orderId),
    isNull(orders.deletedAt),
    ne(orders.status, "incomplete"),
    or(inArray(orders.customerId, owners), inArray(orders.accountOwnerCustomerId, owners)),
  )).get();
  const count = (value: unknown) => Math.max(0, Number(value) || 0);
  return { orders: count(row?.orders), cancelled: count(row?.cancelled), returnedToSender: count(row?.returnedToSender) };
}

/**
 * Records apps' risk checks of an order: one row per app, so a retried check
 * (the same order and app) adds nothing. A lost row never touches the order.
 */
export async function recordAppRiskChecks(
  db: Database,
  orderId: string,
  checks: ReadonlyArray<{ pluginId: string; appName: string; level: OrderAppRiskCheck["level"]; reasons: readonly string[] }>,
): Promise<void> {
  if (checks.length === 0) return;
  const rows = await Promise.all(checks.map(async (check) => ({
    id: `oev_risk${(await sha256Hex(`order-app-risk\0${orderId}\0${check.pluginId}`)).slice(0, 32)}`,
    orderId,
    kind: "app_risk" as const,
    body: null,
    data: JSON.stringify({ pluginId: check.pluginId, appName: check.appName, level: check.level, reasons: check.reasons.slice(0, 5) }),
    actorId: null,
    createdAt: sql`unixepoch()`,
  })));
  for (const chunk of chunkRowsForD1(rows, ORDER_EVENT_PARAMETERS_PER_ROW)) {
    await db.insert(orderEvents).values(chunk).onConflictDoNothing({ target: orderEvents.id });
  }
}
