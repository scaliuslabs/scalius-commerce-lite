// Subscriptions (`acme.subscriptions`): recurring orders as an app, with no
// core edit. Core runs no subscription logic; it gives the app the payment
// primitives (COMMERCE-HOOKS H5, the payment port's `vault` and
// `manualCapture`):
//
// - a purchase option (`subscribe`) buyers pick on a line; core freezes it on
//   the order line (`_purchase_option`) and asks the provider to keep the
//   buyer's payment method when the buyer is signed in;
// - on `order.created`, a subscription contract (an app Object) for every
//   line bought with it;
// - a cron job (`renew`) that, for each contract due, places the renewal
//   (`orders.create`, an invoice for the customer) and charges the saved
//   method off-session (`payments.charge`). A decline marks the contract
//   past due and retries a day later under a new key; three declines cancel
//   it. A charge whose outcome is unknown is repeated under the same key on
//   the next run (it never charges twice).
//
// It also declares the test payment provider (`acme.subscriptions:card`)
// that keeps methods, charges them off-session, authorizes and captures,
// deterministically and without a network: a method reference starting with
// `pm_decline` is declined, `pm_lost` loses its first answer.

import { definePaymentProvider, definePlugin, PLUGIN_API_VERSION, ProviderError, type PaymentEvent, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const SUBSCRIBE_OPTION = "acme.subscriptions.subscribe";
export const CARD_PROVIDER = "acme.subscriptions:card";
/** The fixture provider's webhook signature (a test value, not a secret). */
export const CARD_WEBHOOK_SIGNATURE = "acme-card-test-signature";
const DAY_MS = 86_400_000;
const MAX_DECLINES = 3;

export const manifest = {
  id: "acme.subscriptions",
  name: "Subscriptions",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Subscribe and save: renews subscribed products on schedule and charges the buyer's saved card.",
  author: { name: "Acme" },
  scopes: ["read_orders", "write_orders", "write_payments", "write_payment_methods"],
  events: ["order.created"],
  checkout: {
    purchaseOptions: [{ key: "subscribe", title: "Subscribe and save", description: "Delivered again every month; cancel any time." }],
  },
  settings: [
    { key: "interval_days", label: "Renew every (days)", type: "number", min: 1, max: 365, default: 30 },
  ],
  objects: {
    contracts: {
      name: "Subscription contracts",
      fields: [
        { key: "customer_id", name: "Customer", type: "single_line_text" },
        { key: "source_order_id", name: "First order", type: "single_line_text" },
        { key: "product_id", name: "Product", type: "single_line_text" },
        { key: "variant_id", name: "Variant", type: "single_line_text" },
        { key: "quantity", name: "Quantity", type: "integer" },
        { key: "unit_price_minor", name: "Unit price (minor units)", type: "integer" },
        { key: "currency", name: "Currency", type: "single_line_text" },
        { key: "interval_days", name: "Interval (days)", type: "integer" },
        { key: "next_run_at", name: "Next renewal (ms)", type: "integer" },
        { key: "status", name: "Status", type: "single_line_text" },
        { key: "cycle", name: "Renewals", type: "integer" },
        { key: "declines", name: "Declines in a row", type: "integer" },
        { key: "pending_order_id", name: "Renewal being paid", type: "single_line_text" },
        { key: "last_order_id", name: "Last renewal", type: "single_line_text" },
      ],
      indexes: [["status", "next_run_at"], "customer_id"],
    },
    charges: {
      name: "Card charges (test provider)",
      fields: [{ key: "answer", name: "Answer", type: "json" }],
    },
  },
  providers: {
    payment: [{
      id: "card",
      name: "Acme Card",
      chargeCurrencies: "any",
      operations: ["verifyReturn", "queryPayment", "chargeSavedMethod", "deleteSavedMethod", "capture", "void"],
      capabilities: ["vault", "manualCapture"],
    }],
  },
  cron: [{ name: "renew", schedule: "0 3 * * *" }],
} satisfies PluginManifestInput;

export interface Contract extends Record<string, unknown> {
  customer_id: string;
  source_order_id: string;
  product_id: string;
  variant_id: string;
  quantity: number;
  unit_price_minor: number;
  currency: string;
  interval_days: number;
  next_run_at: number;
  status: "active" | "past_due" | "cancelled";
  cycle: number;
  declines: number;
  pending_order_id: string | null;
  last_order_id: string | null;
}

interface OrderLine { id: string; productId: string; variantId: string | null; quantity: number; unitPriceMinor: number; purchaseOption: string | null }
interface Order { id: string; currency: string; accountCustomerId: string | null; lines: OrderLine[] }
interface SavedMethod { id: string; sourceOrderId: string | null; status: string }

function contracts(ctx: PluginContext) {
  return ctx.objects.contracts!;
}

/** The method to renew with: the one the first order kept, else the customer's newest. */
function pickMethod(methods: SavedMethod[], sourceOrderId: string): SavedMethod | null {
  const active = methods.filter((method) => method.status === "active");
  return active.find((method) => method.sourceOrderId === sourceOrderId) ?? active.at(-1) ?? null;
}

/**
 * One contract's renewal: place the order once per cycle, then charge it
 * once per attempt. Every call carries an Idempotency-Key, so a run that
 * dies anywhere repeats nothing on the next run.
 */
export async function renewContract(ctx: PluginContext, id: string, now: number): Promise<"renewed" | "declined" | "pending" | "skipped"> {
  const version = await contracts(ctx).getVersion(id);
  if (!version) return "skipped";
  const contract = version.data as Contract;
  if (contract.status === "cancelled" || contract.next_run_at > now) return "skipped";
  const cycle = contract.cycle + 1;
  const base = `sub:${id}:${cycle}`;

  const listed = await ctx.api.call<{ paymentMethods: SavedMethod[] }>("payment_methods.list", { query: { customerId: contract.customer_id } });
  const method = listed.ok ? pickMethod(listed.data?.paymentMethods ?? [], contract.source_order_id) : null;
  if (!method) {
    await contracts(ctx).update(id, { status: "past_due", next_run_at: now + DAY_MS });
    ctx.log.warn("No saved payment method to renew with", { contract: id });
    return "declined";
  }

  let orderId = contract.pending_order_id;
  if (!orderId) {
    const placed = await ctx.api.call<{ order: { id: string } }>("orders.create", {
      body: {
        customerId: contract.customer_id,
        items: [{ productId: contract.product_id, variantId: contract.variant_id, quantity: contract.quantity, unitPriceMinor: contract.unit_price_minor }],
        shippingMinor: 0,
        paymentMethod: "net_terms",
        paymentTerms: { kind: "net", days: 7 },
      },
      idempotencyKey: `${base}:order`,
    });
    if (!placed.ok || !placed.data) throw new Error(`The renewal order was not placed (${placed.error?.code ?? placed.status}).`);
    orderId = placed.data.order.id;
    await contracts(ctx).update(id, { pending_order_id: orderId });
  }

  const charged = await ctx.api.call<{ outcome: string }>("payments.charge", {
    path: { id: orderId },
    body: { paymentMethodId: method.id },
    idempotencyKey: `${base}:charge:${contract.declines}`,
  });
  if (charged.ok && charged.data?.outcome === "succeeded") {
    await contracts(ctx).update(id, {
      status: "active",
      cycle,
      declines: 0,
      next_run_at: contract.next_run_at + contract.interval_days * DAY_MS,
      pending_order_id: null,
      last_order_id: orderId,
    });
    return "renewed";
  }
  if (charged.error?.code === "payment_declined") {
    const declines = contract.declines + 1;
    await contracts(ctx).update(id, {
      declines,
      status: declines >= MAX_DECLINES ? "cancelled" : "past_due",
      next_run_at: now + DAY_MS,
    });
    ctx.log.warn("A renewal charge was declined", { contract: id, declines });
    return "declined";
  }
  // Pending its webhook, or the provider's answer was lost: the next run repeats the same key.
  ctx.log.info("A renewal charge is not settled yet", { contract: id, status: charged.status, code: charged.error?.code ?? null });
  return "pending";
}

// ── The test card provider (no network) ─────────────────────────────────────

function chargeEvent(input: { attemptKey: string; orderId: string; amountMinor: number; currency: string; paymentType: "full" | "deposit" | "balance" }, kind: "confirmed" | "authorized"): PaymentEvent {
  return {
    kind,
    eventType: `card.${kind}`,
    eventId: `${kind}_${input.attemptKey}`,
    orderId: input.orderId,
    providerRef: `ch_${input.attemptKey}`,
    secondaryRef: `txn_${input.attemptKey}`,
    amountMinor: input.amountMinor,
    currency: input.currency,
    paymentType: input.paymentType,
  };
}

const card = definePaymentProvider({
  async createSession(input) {
    return { providerRef: `cs_${input.attemptKey}`, redirectUrl: `https://card.acme.test/pay/${encodeURIComponent(input.correlationId)}` };
  },
  // A webhook carries the event as its body, signed with the fixture signature.
  async verifyWebhook(request) {
    if (request.headers["x-acme-card-signature"] !== CARD_WEBHOOK_SIGNATURE) return { status: "invalid", reason: "Bad signature" };
    return { status: "event", event: JSON.parse(request.rawBody) as PaymentEvent };
  },
  async verifyReturn(request) {
    if (request.headers["x-acme-card-signature"] !== CARD_WEBHOOK_SIGNATURE) return { status: "ignored", reason: "Unsigned return" };
    return { status: "event", event: JSON.parse(request.rawBody) as PaymentEvent };
  },
  async queryPayment() {
    return { providerStatus: "pending" };
  },
  // Idempotent by the attempt key: a repeat answers the first outcome.
  async chargeSavedMethod(input, ctx) {
    const charges = ctx.objects.charges!;
    const stored = await charges.get(input.attemptKey);
    if (stored) return stored.answer as never;
    if (input.methodRef.startsWith("pm_decline")) {
      const declined = { status: "declined" as const, reason: "The card was declined.", code: "card_declined" };
      await charges.put(input.attemptKey, { answer: declined });
      return declined;
    }
    const answer = { status: "event" as const, event: chargeEvent(input, input.capture === "manual" ? "authorized" : "confirmed") };
    await charges.put(input.attemptKey, { answer });
    // A `pm_lost` method is charged, but its first answer never reaches the store (a repeat finds it above).
    if (input.methodRef.startsWith("pm_lost")) {
      throw new ProviderError("retryable", "The card network timed out after the charge was sent.", { uncertain: true, code: "card_timeout" });
    }
    return answer;
  },
  async capture(input) {
    return {
      status: "event",
      event: {
        kind: "confirmed", eventType: "card.captured", eventId: `captured_${input.providerRef}`, orderId: input.orderId,
        providerRef: input.providerRef, secondaryRef: `txn_${input.providerRef}`, amountMinor: input.amountMinor, currency: input.currency,
      },
    };
  },
  async void() {
    return { status: "voided" };
  },
  async deleteSavedMethod() {
    return { status: "deleted" };
  },
});

export default definePlugin({
  manifest,

  events: {
    // One contract per subscribed line of an account customer's order (a guest cannot be renewed).
    "order.created": async (event, ctx) => {
      const read = await ctx.api.call<{ order: Order }>("orders.get", { path: { id: event.resource.id } });
      if (!read.ok || !read.data?.order) throw new Error(`The order could not be read (${read.error?.code ?? read.status}).`);
      const order = read.data.order;
      if (!order.accountCustomerId) return;
      const intervalDays = Number(ctx.settings.interval_days ?? 30) || 30;
      const placedAt = Date.parse(event.occurredAt) || 0;
      for (const line of order.lines) {
        if (line.purchaseOption !== SUBSCRIBE_OPTION || !line.variantId) continue;
        const id = `${order.id}:${line.id}`;
        if (await contracts(ctx).get(id)) continue;
        await contracts(ctx).put(id, {
          customer_id: order.accountCustomerId,
          source_order_id: order.id,
          product_id: line.productId,
          variant_id: line.variantId,
          quantity: line.quantity,
          unit_price_minor: line.unitPriceMinor,
          currency: order.currency,
          interval_days: intervalDays,
          next_run_at: placedAt + intervalDays * DAY_MS,
          status: "active",
          cycle: 0,
          declines: 0,
          pending_order_id: null,
          last_order_id: null,
        } satisfies Contract, { expectedRevision: null });
      }
    },
  },

  cron: {
    renew: async (ctx, run) => {
      const now = Date.parse(run.scheduledAt);
      let renewed = 0;
      for (const status of ["active", "past_due"] as const) {
        const due = await contracts(ctx).query({ where: { status }, orderBy: { field: "next_run_at", direction: "asc" }, limit: 50 });
        for (const record of due.records) {
          if (Number(record.data.next_run_at) > now) break;
          if (await renewContract(ctx, record.id, now) === "renewed") renewed += 1;
        }
      }
      ctx.log.info("Renewed subscriptions", { renewed });
    },
  },

  providers: { card },
});
