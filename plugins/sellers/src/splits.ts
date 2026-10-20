// Order splits: when an order is placed, each seller's lines become that
// seller's split (its subtotal, the store's commission and the seller's
// net), the order's timeline says how it split, and each seller gets an
// email. Later order events move every split of the order along (paid,
// fulfilled, cancelled, refunded). Payouts settle fulfilled splits.
//
// Delivery is at least once: a split's id is `<order id>~<seller id>` and
// is created only when absent, so a redelivered `order.created` changes
// nothing and mails nobody twice; status moves write only on a change.

import type { PluginContext, PluginEvent } from "@scalius/plugin-sdk";
import {
  commissionBps,
  commissionOf,
  errorCode,
  minorToMajor,
  payable,
  payouts,
  plain,
  productSellers,
  sellers,
  splitIdOf,
  splits,
  type OrderSplit,
  type Payout,
  type SplitLine,
  type SplitStatus,
} from "./model";

/** The order as `dashboard.resources.orders.get` returns it (the fields the app reads). */
export interface OrderResource {
  id: string;
  orderNumber: number | null;
  currency: string;
  status: string;
  lines: Array<{ id: string; productId: string; variantId: string | null; title: string | null; variantLabel: string | null; quantity: number; subtotalMinor: number; discountMinor: number }>;
}

/** Distinct products an order may name before the split leaves the rest with the store (bounds the run's platform calls). */
export const MAX_SPLIT_PRODUCTS = 30;

export async function readOrder(ctx: PluginContext, orderId: string): Promise<OrderResource> {
  const result = await ctx.api.call<{ data?: OrderResource }>("dashboard.resources.orders.get", { path: { id: orderId } });
  const order = result.data?.data;
  // A transient read failure throws, so the platform retries the event.
  if (!result.ok || !order) throw Object.assign(new Error(`The order could not be read (${result.status}).`), { code: result.error?.code ?? "order.unreadable" });
  return order;
}

/** Each seller's lines of an order: seller id → lines. Lines of products no seller owns stay with the store. */
export async function groupBySeller(ctx: PluginContext, order: OrderResource): Promise<Map<string, SplitLine[]>> {
  const owners = new Map<string, string | null>();
  for (const productId of [...new Set(order.lines.map((line) => line.productId))].slice(0, MAX_SPLIT_PRODUCTS)) {
    owners.set(productId, (await productSellers(ctx).get(productId))?.seller_id ?? null);
  }
  const groups = new Map<string, SplitLine[]>();
  for (const line of order.lines) {
    const sellerId = owners.get(line.productId);
    if (!sellerId) continue;
    const title = [plain(line.title, 160), plain(line.variantLabel, 80)].filter(Boolean).join(" - ") || line.productId;
    const lines = groups.get(sellerId) ?? [];
    lines.push({
      line_id: line.id,
      product_id: line.productId,
      variant_id: line.variantId,
      title,
      quantity: line.quantity,
      subtotal_minor: Math.max(0, line.subtotalMinor - line.discountMinor),
    });
    groups.set(sellerId, lines);
  }
  return groups;
}

/** Splits a placed order by seller. Returns the splits it created now (none on a redelivery). */
export async function splitOrder(ctx: PluginContext, event: PluginEvent): Promise<OrderSplit[]> {
  const order = await readOrder(ctx, event.resource.id);
  const groups = await groupBySeller(ctx, order);
  if (groups.size === 0) return [];
  const created: OrderSplit[] = [];
  const createdAt = Date.parse(event.occurredAt) || Date.now();
  for (const [sellerId, lines] of groups) {
    const seller = await sellers(ctx).get(sellerId);
    const subtotal = lines.reduce((sum, line) => sum + line.subtotal_minor, 0);
    const commission = commissionOf(subtotal, seller ? commissionBps(seller, ctx.settings) : commissionBps({ commission_bps: null }, ctx.settings));
    const split: OrderSplit = {
      order_id: order.id,
      order_number: order.orderNumber,
      seller_id: sellerId,
      status: "open",
      lines: lines.slice(0, 100),
      item_count: lines.reduce((sum, line) => sum + line.quantity, 0),
      subtotal_minor: subtotal,
      commission_minor: commission,
      net_minor: subtotal - commission,
      currency: order.currency,
      created_at: createdAt,
      payout_id: null,
    };
    try {
      await splits(ctx).put(splitIdOf(order.id, sellerId), split, { expectedRevision: null });
      created.push(split);
    } catch (error) {
      // Split on an earlier delivery: its notice is sent again below under the
      // same key, so a run that died between the write and the send still
      // notifies the seller, and one that sent it sends nothing.
      if (errorCode(error) !== "object.conflict") throw error;
    }
    if (seller?.email) {
      const number = order.orderNumber ?? order.id;
      const items = split.lines.map((line) => `${line.quantity} x ${line.title}`).join("\n");
      await ctx.messaging.email({
        to: seller.email,
        subject: plain(`New order ${number} for ${seller.name}`, 200),
        text: `You have a new order (${number}) at ${ctx.store.name}.\n\n${items}\n\nSubtotal: ${minorToMajor(subtotal, ctx.store.decimalPlaces)} ${order.currency}\nCommission: ${minorToMajor(commission, ctx.store.decimalPlaces)} ${order.currency}\nYour net: ${minorToMajor(split.net_minor, ctx.store.decimalPlaces)} ${order.currency}\n\nOpen your seller dashboard to fulfil it.`,
        html: `<p>You have a new order (${escapeText(String(number))}) at ${escapeText(ctx.store.name)}.</p><ul>${split.lines.map((line) => `<li>${line.quantity} x ${escapeText(line.title)}</li>`).join("")}</ul><p>Your net: ${minorToMajor(split.net_minor, ctx.store.decimalPlaces)} ${escapeText(order.currency)}</p><p>Open your seller dashboard to fulfil it.</p>`,
        // Once per split, however often the event is delivered.
        idempotencyKey: `sellers-split-notice-${splitIdOf(order.id, sellerId)}`.slice(0, 200),
      }).catch((error: unknown) => {
        // A busy or failing platform retries the event (the key keeps it to one email); a refusal will not change.
        const code = errorCode(error);
        if (code === "rate_limited" || code === "internal") throw error;
        ctx.log.warn("A seller notice was not sent", { sellerId, code });
      });
    }
  }
  if (created.length > 0) {
    await ctx.timeline.add({
      orderId: order.id,
      kind: "split",
      message: created.length === 1 ? "Sold by one marketplace seller." : `Split between ${created.length} marketplace sellers.`,
      fields: { sellers: created.length, items: created.reduce((sum, split) => sum + split.item_count, 0) },
      idempotencyKey: event.id,
    });
  }
  return created;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** What each later order event makes of a split; null leaves the split as it is. */
export function nextStatus(topic: string, current: SplitStatus): SplitStatus | null {
  if (current === "cancelled" || current === "refunded") return null;
  if (topic === "order.cancelled") return "cancelled";
  if (topic === "order.refunded") return "refunded";
  if (topic === "order.fulfilled") return current === "fulfilled" ? null : "fulfilled";
  if (topic === "order.paid") return current === "open" ? "paid" : null;
  return null;
}

/** Moves every split of the order by the event; writes only the ones that change. A split already paid out keeps its status. */
export async function moveSplits(ctx: PluginContext, event: PluginEvent): Promise<number> {
  const page = await splits(ctx).query({ where: { order_id: event.resource.id }, limit: 100 });
  let moved = 0;
  for (const record of page.records) {
    const next = nextStatus(event.topic, record.data.status);
    if (!next || record.data.payout_id) continue;
    await splits(ctx).put(record.id, { ...record.data, status: next }, { expectedRevision: record.revision });
    moved += 1;
  }
  return moved;
}

/** Splits one payout settles at most: one payout record plus the splits fit one atomic batch of 25. */
export const PAYOUT_BATCH = 24;

/**
 * Drafts a payout for each approved seller with fulfilled, unsettled splits
 * placed before `periodEnd`: one atomic batch writes the payout and marks
 * its splits at the revisions read, so a split is never settled twice. A
 * seller with more splits gets another payout on the next run.
 */
export async function draftPayouts(ctx: PluginContext, periodEnd: number, run: string): Promise<Payout[]> {
  const drafted: Payout[] = [];
  const approved = await sellers(ctx).query({ where: { status: "approved" }, orderBy: { field: "created_at", direction: "asc" }, limit: 100 });
  for (const seller of approved.records) {
    const open = await splits(ctx).query({ where: { seller_id: seller.id, payout_id: null }, orderBy: { field: "created_at", direction: "asc" }, limit: 100 });
    const due = open.records.filter((record) => payable(record.data) && record.data.created_at < periodEnd);
    if (due.length === 0) continue;
    // One currency per payout: the first split's.
    const currency = due[0]!.data.currency;
    const batch = due.filter((record) => record.data.currency === currency).slice(0, PAYOUT_BATCH);
    const id = `${seller.id}~${new Date(periodEnd).toISOString().slice(0, 10)}~${run}`;
    const payout: Payout = {
      seller_id: seller.id,
      period_end: periodEnd,
      gross_minor: batch.reduce((sum, record) => sum + record.data.subtotal_minor, 0),
      commission_minor: batch.reduce((sum, record) => sum + record.data.commission_minor, 0),
      net_minor: batch.reduce((sum, record) => sum + record.data.net_minor, 0),
      currency,
      split_count: batch.length,
      status: "draft",
      created_at: Date.now(),
      paid_at: null,
      reference: null,
    };
    try {
      await ctx.objects.batch([
        { op: "put", object: "payouts", id, record: payout, expectedRevision: null },
        ...batch.map((record) => ({ op: "put" as const, object: "order_splits", id: record.id, record: { ...record.data, payout_id: id }, expectedRevision: record.revision })),
      ]);
      drafted.push(payout);
    } catch (error) {
      if (errorCode(error) !== "object.conflict") throw error;
      ctx.log.info("A payout was drafted meanwhile", { sellerId: seller.id });
    }
  }
  return drafted;
}

/** Approves a draft payout, or records it as paid with the merchant's transfer reference. */
export async function setPayoutStatus(ctx: PluginContext, id: string, status: "approved" | "paid", reference: string | null): Promise<Payout | null> {
  const current = await payouts(ctx).getVersion(id);
  if (!current) return null;
  const order = ["draft", "approved", "paid"];
  if (order.indexOf(status) <= order.indexOf(current.data.status)) return current.data;
  const next: Payout = { ...current.data, status, ...(status === "paid" ? { paid_at: Date.now(), reference: reference ? plain(reference, 80) : null } : {}) };
  await payouts(ctx).put(id, next, { expectedRevision: current.revision });
  return next;
}
