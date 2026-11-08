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
//
// Sellers are paid with core payouts (`payouts.create`, the Sensitive
// `write_payouts`): the `settle` cron pays each seller (the `sellers` object
// holds their payout account) what `payableMinor` says minus what was already
// sent and not failed. Each payout is recorded in `seller_payouts` before it
// is sent, under a key per seller, currency and settlement round
// (`mkt:<seller>:<currency>:<round>`); one whose answer is unknown is resent
// with the same key and body next run, never as a new round. `payout.created`
// and `payout.updated` record what the provider answered.
//
// The app also declares the fixture payout provider (`acme.marketplace:payouts`):
// deterministic, no network, one payout per `payoutId` (its `sent` object). An
// account ref starting `acct_decline` is declined, `acct_lost` loses its first
// answer (a retryable uncertain error after the payout was applied),
// `acct_slow` answers `processing` and settles by a signed callback.

import { definePayoutProvider, definePlugin, PLUGIN_API_VERSION, ProviderError, type PluginContext, type PluginEvent, type PluginManifestInput } from "@scalius/plugin-sdk";

export const PAYOUT_PROVIDER = "acme.marketplace:payouts";
/** The fixture provider's callback signature (a test value, not a secret). */
export const PAYOUT_WEBHOOK_SIGNATURE = "acme-payouts-test-signature";

export const manifest = {
  id: "acme.marketplace",
  name: "Marketplace splitter",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Splits every order per seller and keeps each seller's fulfilled and refunded units from the order's line facts.",
  author: { name: "Acme" },
  scopes: ["read_orders", "write_payouts"],
  events: ["order.created", "fulfillment.created", "fulfillment.voided", "refund.updated", "payout.created", "payout.updated"],
  objects: {
    sellers: {
      name: "Sellers",
      fields: [{ key: "payout_account", name: "Payout account", type: "single_line_text" }],
    },
    seller_payouts: {
      name: "Seller payouts",
      fields: [
        { key: "seller_id", name: "Seller", type: "single_line_text" },
        { key: "currency", name: "Currency", type: "single_line_text" },
        { key: "round", name: "Settlement round", type: "integer" },
        { key: "amount_minor", name: "Amount (minor units)", type: "integer" },
        { key: "account", name: "Payout account", type: "single_line_text" },
        /** `sending` (recorded, no answer yet), `processing`, `paid` or `failed`. */
        { key: "status", name: "Status", type: "single_line_text" },
        { key: "payout_id", name: "Payout", type: "single_line_text" },
        { key: "failure_code", name: "Failure", type: "single_line_text" },
      ],
      indexes: ["seller_id", "payout_id"],
    },
    sent: {
      name: "Payouts applied (test provider)",
      fields: [
        { key: "answer", name: "Answer", type: "json" },
        { key: "calls", name: "Calls", type: "integer" },
      ],
    },
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
  providers: {
    payout: [{ id: "payouts", name: "Acme Payouts", operations: ["verifyWebhook"] }],
  },
  cron: [{ name: "settle", schedule: "0 4 * * *" }],
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

// ── Paying sellers ──────────────────────────────────────────────────────────

export interface SellerPayout extends Record<string, unknown> {
  seller_id: string;
  currency: string;
  round: number;
  amount_minor: number;
  account: string;
  status: "sending" | "processing" | "paid" | "failed";
  payout_id: string | null;
  failure_code: string | null;
}

interface PayoutRecord { id: string; status: "pending" | "processing" | "paid" | "failed"; payeeRef: string; amountMinor: number; currency: string; failureCode: string | null }

async function allRecords<T extends Record<string, unknown>>(ctx: PluginContext, object: string, where: Record<string, string>): Promise<Array<{ id: string; revision: number; data: T }>> {
  const rows: Array<{ id: string; revision: number; data: T }> = [];
  let cursor: string | null = null;
  do {
    const page = await ctx.objects[object]!.query({ where, limit: 50, cursor });
    rows.push(...page.records.map((record) => ({ id: record.id, revision: record.revision, data: record.data as T })));
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

/** The status the app keeps from a payout the platform answered. */
const keptStatus = (status: PayoutRecord["status"]): SellerPayout["status"] => status === "pending" ? "sending" : status;

/** Sends (or resends) one recorded payout and keeps what the platform answered. */
async function sendSellerPayout(ctx: PluginContext, key: string, payout: SellerPayout): Promise<SellerPayout["status"]> {
  const sent = await ctx.api.call<{ payout: PayoutRecord }>("payouts.create", {
    body: {
      providerId: PAYOUT_PROVIDER,
      payeeRef: payout.seller_id,
      payeeAccountRef: payout.account,
      amountMinor: payout.amount_minor,
      currency: payout.currency,
      description: `Marketplace settlement ${payout.round}`,
    },
    idempotencyKey: key,
  });
  if (!sent.ok || !sent.data) {
    // Unknown (the provider's answer was lost): the next run resends the same key.
    ctx.log.warn("A seller payout is not answered yet", { key, code: sent.error?.code ?? null });
    return "sending";
  }
  const status = keptStatus(sent.data.payout.status);
  await ctx.objects.seller_payouts!.update(key, { status, payout_id: sent.data.payout.id, failure_code: sent.data.payout.failureCode });
  return status;
}

/**
 * Pays one seller what they are owed in each currency: payable minus what was
 * sent and did not fail. A payout still unanswered is resent first (same key,
 * same body); an account whose last payout failed is not tried again until
 * the seller's account changes.
 */
export async function settleSeller(ctx: PluginContext, sellerId: string): Promise<number> {
  const seller = await ctx.objects.sellers!.get(sellerId) as { payout_account?: string } | null;
  if (!seller?.payout_account) return 0;
  const owedBy = new Map<string, number>();
  for (const split of await allRecords<Split>(ctx, "splits", { seller_id: sellerId })) {
    owedBy.set(split.data.currency, (owedBy.get(split.data.currency) ?? 0) + payableMinor(split.data));
  }
  const records = await allRecords<SellerPayout>(ctx, "seller_payouts", { seller_id: sellerId });
  let sent = 0;
  for (const [currency, payable] of owedBy) {
    const mine = records.filter((record) => record.data.currency === currency).sort((a, b) => a.data.round - b.data.round);
    const unanswered = mine.find((record) => record.data.status === "sending");
    if (unanswered) {
      await sendSellerPayout(ctx, unanswered.id, unanswered.data);
      sent += 1;
      continue;
    }
    const last = mine.at(-1)?.data;
    if (last?.status === "failed" && last.account === seller.payout_account) continue;
    const paid = mine.filter((record) => record.data.status !== "failed").reduce((total, record) => total + record.data.amount_minor, 0);
    const owed = payable - paid;
    if (owed <= 0) continue;
    const round = (last?.round ?? 0) + 1;
    const key = `mkt:${sellerId}:${currency}:${round}`;
    const payout: SellerPayout = {
      seller_id: sellerId, currency, round, amount_minor: owed, account: seller.payout_account,
      status: "sending", payout_id: null, failure_code: null,
    };
    // Recorded before it is sent: a run that dies after the call resends this key.
    await ctx.objects.seller_payouts!.put(key, payout, { expectedRevision: null });
    await sendSellerPayout(ctx, key, payout);
    sent += 1;
  }
  return sent;
}

/** `payout.created` / `payout.updated`: keeps the platform's status on the app's record of the payout. */
async function recordPayoutEvent(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const payoutId = typeof event.facts.payoutId === "string" ? event.facts.payoutId : "";
  if (!payoutId) return;
  const read = await ctx.api.call<{ payout: PayoutRecord }>("payouts.get", { path: { id: payoutId } });
  if (!read.ok || !read.data) throw new Error(`payouts.get failed: ${read.error?.code ?? read.status}`);
  const payout = read.data.payout;
  const byId = await ctx.objects.seller_payouts!.query({ where: { payout_id: payoutId }, limit: 1 });
  // A payout whose create answer was lost is the seller's one unanswered record of that amount.
  const record = byId.records[0] ?? (await allRecords<SellerPayout>(ctx, "seller_payouts", { seller_id: payout.payeeRef }))
    .find((row) => row.data.status === "sending" && !row.data.payout_id && row.data.amount_minor === payout.amountMinor && row.data.currency === payout.currency);
  if (!record) return;
  await ctx.objects.seller_payouts!.update(record.id, { status: keptStatus(payout.status), payout_id: payout.id, failure_code: payout.failureCode });
}

// ── The fixture payout provider (no network) ────────────────────────────────

interface SentPayout extends Record<string, unknown> {
  answer: { status: "processing" | "paid" | "failed"; providerRef: string; failureCode?: string; reason?: string };
  calls: number;
}

const payoutsProvider = definePayoutProvider({
  // Applied once per payoutId: a repeat answers the first payout and counts the call.
  async createPayout(input, ctx) {
    const sent = ctx.objects.sent!;
    const stored = await sent.get(input.payoutId) as SentPayout | null;
    const account = input.payee.accountRef ?? "";
    if (stored) {
      await sent.update(input.payoutId, { calls: stored.calls + 1 });
      if (stored.answer.status === "failed") throw new ProviderError("declined", stored.answer.reason ?? "Declined.", { code: stored.answer.failureCode });
      return stored.answer;
    }
    const providerRef = `po_${input.payoutId}`;
    if (account.startsWith("acct_decline")) {
      await sent.put(input.payoutId, { answer: { status: "failed", providerRef, failureCode: "account_closed", reason: "The payee account is closed." }, calls: 1 });
      throw new ProviderError("declined", "The payee account is closed.", { code: "account_closed" });
    }
    const answer = { status: account.startsWith("acct_slow") ? "processing" as const : "paid" as const, providerRef };
    await sent.put(input.payoutId, { answer, calls: 1 });
    // An `acct_lost` payout is applied, but its first answer never reaches the store.
    if (account.startsWith("acct_lost")) {
      throw new ProviderError("retryable", "The payout network timed out after the transfer was sent.", { uncertain: true, code: "payout_timeout" });
    }
    return answer;
  },
  async payoutStatus(input, ctx) {
    const stored = await ctx.objects.sent!.get(input.payoutId) as SentPayout | null;
    return stored ? stored.answer : { status: "unknown" as const };
  },
  // A callback carries `{ updates }` as its body, signed with the fixture signature.
  async verifyWebhook(request) {
    if (request.headers["x-acme-payout-signature"] !== PAYOUT_WEBHOOK_SIGNATURE) return { status: "invalid", reason: "Bad signature" };
    return { status: "updates", updates: (JSON.parse(request.rawBody) as { updates: never }).updates };
  },
});

export default definePlugin({
  manifest,
  cron: {
    settle: async (ctx) => {
      let cursor: string | null = null;
      let sent = 0;
      do {
        const page = await ctx.objects.sellers!.query({ limit: 50, cursor });
        for (const seller of page.records) sent += await settleSeller(ctx, seller.id);
        cursor = page.nextCursor;
      } while (cursor);
      ctx.log.info("Settled sellers", { sent });
    },
  },
  providers: { payouts: payoutsProvider },
  events: {
    "payout.created": recordPayoutEvent,
    "payout.updated": recordPayoutEvent,
    "order.created": splitOrder,
    "fulfillment.created": (event, ctx) => moveUnits(event, ctx, (line, quantity) => { line.fulfilled = Math.min(line.ordered, line.fulfilled + quantity); }),
    "fulfillment.voided": (event, ctx) => moveUnits(event, ctx, (line, quantity) => { line.fulfilled = Math.max(0, line.fulfilled - quantity); }),
    "refund.updated": (event, ctx) => event.facts.status === "refunded"
      ? moveUnits(event, ctx, (line, quantity) => { line.refunded = Math.min(line.ordered, line.refunded + quantity); })
      : event.facts.status === "partial" ? moveUnits(event, ctx, () => undefined, true) : Promise.resolve(),
  },
});
