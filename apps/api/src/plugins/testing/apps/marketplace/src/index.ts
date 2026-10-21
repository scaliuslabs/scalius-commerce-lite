// Marketplace splitter (`acme.marketplace`): a multi-seller store as an app,
// with no core edit. Each product is listed by a seller (the `listings`
// object, keyed by product id); a new order is split per seller with each
// seller's lines, and the line facts of the platform's events move units:
//
// - `fulfillment.created` / `fulfillment.voided`: `lines` are the units
//   handed over (or put back), so a seller is fulfilled when their lines are,
//   whatever the rest of the order does;
// - `refund.updated` settled as `refunded`: `lines` are the units the money
//   was for, so a refund of one seller's line never touches another's payout.
//   A `partial` refund (some of its payments failed) holds the split for
//   review instead of guessing.
//
// Facts carry ids and quantities only; money is read from `orders.get` (the
// sealed representation, integer minor units). Every handler is idempotent per
// event: the event id is recorded in the same atomic batch as the split.

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginEvent, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.marketplace",
  name: "Marketplace splitter",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Splits every order per seller and keeps each seller's fulfilled and refunded units from the order's line facts.",
  author: { name: "Acme" },
  scopes: ["read_orders"],
  events: ["order.created", "fulfillment.created", "fulfillment.voided", "refund.updated"],
  objects: {
    listings: {
      name: "Listings",
      fields: [{ key: "seller_id", name: "Seller", type: "single_line_text" }],
      indexes: ["seller_id"],
    },
    splits: {
      name: "Seller splits",
      fields: [
        { key: "order_id", name: "Order", type: "single_line_text" },
        { key: "seller_id", name: "Seller", type: "single_line_text" },
        /** By order line id: `{ ordered, fulfilled, refunded, unitMinor }`. */
        { key: "lines", name: "Lines", type: "json" },
        { key: "currency", name: "Currency", type: "single_line_text" },
        { key: "review", name: "Needs review", type: "boolean" },
      ],
      indexes: ["order_id", "seller_id"],
    },
    applied: {
      name: "Applied events",
      fields: [{ key: "topic", name: "Topic", type: "single_line_text" }],
    },
  },
} satisfies PluginManifestInput;

export interface SplitLine {
  ordered: number;
  fulfilled: number;
  refunded: number;
  /** What one unit was sold for after discounts, in minor units of `currency`. */
  unitMinor: number;
}

export interface Split extends Record<string, unknown> {
  order_id: string;
  seller_id: string;
  lines: Record<string, SplitLine>;
  currency: string;
  review: boolean;
}

/** The store's own lines, when no seller lists the product. */
export const HOUSE_SELLER = "house";

interface OrderLine { id: string; productId: string; quantity: number; subtotalMinor: number; discountMinor: number }
interface FactLine { orderItemId: string; quantity: number }

const factLines = (event: PluginEvent): FactLine[] => {
  const lines = event.facts.lines;
  return Array.isArray(lines)
    ? lines.filter((line): line is FactLine => typeof line?.orderItemId === "string" && Number.isInteger(line?.quantity))
    : [];
};

/** What a seller is owed now: the units handed over and not refunded, at what they sold for. */
export function payableMinor(split: Split): number {
  return Object.values(split.lines).reduce((total, line) => total + Math.max(0, line.fulfilled - line.refunded) * line.unitMinor, 0);
}

async function splitOrder(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const orderId = event.resource.id;
  const read = await ctx.api.call<{ order: { currency: string; lines: OrderLine[] } }>("orders.get", { path: { id: orderId } });
  if (!read.ok || !read.data?.order) throw new Error(`orders.get failed: ${read.error?.code ?? "unknown"}`);
  const { currency, lines } = read.data.order;
  const bySeller = new Map<string, Split>();
  for (const line of lines) {
    const listing = await ctx.objects.listings!.get(line.productId) as { seller_id?: string } | null;
    const sellerId = listing?.seller_id || HOUSE_SELLER;
    const split = bySeller.get(sellerId) ?? { order_id: orderId, seller_id: sellerId, lines: {}, currency, review: false };
    split.lines[line.id] = {
      ordered: line.quantity,
      fulfilled: 0,
      refunded: 0,
      unitMinor: line.quantity > 0 ? Math.floor((line.subtotalMinor - line.discountMinor) / line.quantity) : 0,
    };
    bySeller.set(sellerId, split);
  }
  await ctx.objects.batch([
    { op: "put", object: "applied", id: event.id, record: { topic: event.topic }, expectedRevision: null },
    ...[...bySeller].map(([sellerId, split]) => ({ op: "put" as const, object: "splits", id: `${orderId}:${sellerId}`, record: split, expectedRevision: null })),
  ]).catch((error: unknown) => ignoreReplay(error, event, ctx));
}

/** Moves each named line's units in the split that holds it, in one batch with the event's record. */
async function moveUnits(event: PluginEvent, ctx: PluginContext, move: (line: SplitLine, quantity: number) => void, flag = false): Promise<void> {
  const orderId = typeof event.facts.orderId === "string" ? event.facts.orderId : "";
  const lines = factLines(event);
  if (!orderId || (lines.length === 0 && !flag)) return;
  const { records } = await ctx.objects.splits!.query({ where: { order_id: orderId }, limit: 50 });
  const changed: Array<{ id: string; revision: number; data: Split }> = [];
  for (const record of records) {
    const data = structuredClone(record.data) as Split;
    let touched = false;
    for (const line of lines) {
      const held = data.lines[line.orderItemId];
      if (!held) continue;
      if (flag) data.review = true;
      else move(held, line.quantity);
      touched = true;
    }
    if (touched) changed.push({ id: record.id, revision: record.revision, data });
  }
  await ctx.objects.batch([
    { op: "put", object: "applied", id: event.id, record: { topic: event.topic }, expectedRevision: null },
    ...changed.map((split) => ({ op: "put" as const, object: "splits", id: split.id, record: split.data, expectedRevision: split.revision })),
  ]).catch((error: unknown) => ignoreReplay(error, event, ctx));
}

/**
 * A redelivered event finds its record already written: nothing more to do.
 * Any other conflict (a concurrent write to a split) is thrown, so the
 * platform redelivers the event and it is applied on the fresh split.
 */
async function ignoreReplay(error: unknown, event: PluginEvent, ctx: PluginContext): Promise<void> {
  const code = (error as { code?: string } | null)?.code;
  if (code === "object_conflict" && await ctx.objects.applied!.get(event.id)) return;
  throw error;
}

export default definePlugin({
  manifest,
  events: {
    "order.created": splitOrder,
    "fulfillment.created": (event, ctx) => moveUnits(event, ctx, (line, quantity) => { line.fulfilled = Math.min(line.ordered, line.fulfilled + quantity); }),
    "fulfillment.voided": (event, ctx) => moveUnits(event, ctx, (line, quantity) => { line.fulfilled = Math.max(0, line.fulfilled - quantity); }),
    "refund.updated": (event, ctx) => event.facts.status === "refunded"
      ? moveUnits(event, ctx, (line, quantity) => { line.refunded = Math.min(line.ordered, line.refunded + quantity); })
      : event.facts.status === "partial" ? moveUnits(event, ctx, () => undefined, true) : Promise.resolve(),
  },
});
