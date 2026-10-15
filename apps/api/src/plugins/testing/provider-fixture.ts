// A payment provider app written without the SDK, run by both loaders in
// the provider tests (providers.bundled.test.ts, plugins.sandbox.test.ts):
// the same bytes, so both prove the same behaviour. It stores its sessions in
// its own objects (idempotent by attempt key), authenticates webhooks with
// its secret setting, and fails in the ways the port defines.

import { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";

export const WALLET_FIXTURE_ID = "acme.wallet";
export const WALLET_FIXTURE_SECRET = "wallet-fixture-secret-0123456789";

export const WALLET_FIXTURE_MANIFEST = {
  id: WALLET_FIXTURE_ID,
  name: "Acme Wallet",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A wallet provider fixture for both plugin loaders.",
  author: { name: "Acme" },
  settings: [{ key: "secret", label: "Webhook secret", type: "secret", required: true }],
  objects: {
    sessions: {
      name: "Sessions",
      fields: [
        { key: "session", name: "Session", type: "json" },
        { key: "order_id", name: "Order", type: "single_line_text" },
      ],
    },
  },
  providers: {
    payment: [{
      id: "wallet",
      name: "Acme Wallet",
      chargeCurrencies: ["BDT"],
      operations: ["verifyReturn", "queryPayment", "testConnection"],
    }],
  },
} as const;

/** The module source (ES module, no imports). */
export const WALLET_FIXTURE_CODE = `
const manifest = ${JSON.stringify(WALLET_FIXTURE_MANIFEST)};
function providerError(category, message, options = {}) {
  const error = new Error(message);
  error.name = "ProviderError";
  error.category = category;
  error.uncertain = options.uncertain === true;
  error.code = options.code;
  return error;
}
export default {
  manifest,
  providers: {
    wallet: {
      kind: "payment",
      async createSession(input, ctx) {
        if (input.amountMinor === 1300) throw providerError("declined", "The wallet declined the payment.", { code: "wallet.declined" });
        if (input.amountMinor === 1400) throw providerError("retryable", "Timed out after sending; secret " + ctx.settings.secret, { uncertain: true, code: "wallet.timeout" });
        if (input.amountMinor === 1500) return { redirectUrl: "http://insecure.example/pay" };
        if (input.amountMinor === 1600) throw new TypeError("boom");
        const existing = await ctx.objects.sessions.get(input.attemptKey);
        if (existing) return existing.session;
        const session = {
          providerRef: "W-" + input.correlationId,
          redirectUrl: "https://wallet.acme.test/pay?amount=" + input.wireAmount.decimal + "&currency=" + input.currency,
        };
        // Written once per attempt (a racing retry finds it): the atomic batch path in either loader.
        const [revision] = (await ctx.objects.batch([
          { op: "put", object: "sessions", id: input.attemptKey, record: { session, order_id: input.orderId }, expectedRevision: null },
        ])).revisions;
        ctx.log.info("Session created", { orderId: input.orderId, revision });
        return session;
      },
      async verifyWebhook(request, ctx) {
        if (request.headers["x-wallet-signature"] !== ctx.settings.secret) return { status: "invalid", reason: "Bad signature" };
        const body = JSON.parse(request.rawBody);
        return {
          status: "event",
          event: {
            kind: "confirmed", eventType: "wallet.paid", eventId: body.id, orderId: body.orderId,
            providerRef: body.ref, amountMinor: body.amountMinor, currency: "BDT",
          },
        };
      },
      async verifyReturn(request, ctx) {
        return this.verifyWebhook(request, ctx);
      },
      async queryPayment(input) {
        return { providerStatus: "pending" };
      },
      async testConnection(_input, ctx) {
        return { ok: ctx.settings.secret.length > 8, message: "Secret saved." };
      },
    },
  },
};
`;

export const walletSessionInput = (amountMinor: number) => ({
  attemptKey: `attempt-${amountMinor}`,
  correlationId: `ORD1_full_${amountMinor}`,
  orderId: "ORD1",
  paymentType: "full" as const,
  amountMinor,
  currency: "BDT",
  wireAmount: { minor: amountMinor, decimal: (amountMinor / 100).toFixed(2) },
  buyer: { name: "Buyer", phone: "+8801700000000" },
  urls: { success: "https://api.shop.test/s", fail: "https://api.shop.test/f", cancel: "https://api.shop.test/c", webhook: "https://api.shop.test/w" },
  requestTimeoutMs: 10_000,
});

// A courier app written without the SDK (providers/courier.test.ts): it books
// parcels in its own objects (idempotent by the shipment id), finds a booking
// by the order id, authenticates tracking pushes with its secret setting, and
// fails in the ways the port defines. "ORD-DECLINE" is refused before
// booking; "ORD-TIMEOUT" is booked and then times out, as a lost answer does.

export const PARCEL_FIXTURE_ID = "acme.parcel";
export const PARCEL_COURIER_ID = `${PARCEL_FIXTURE_ID}:parcel`;
export const PARCEL_FIXTURE_SECRET = "parcel-fixture-secret-0123456789";

export const PARCEL_FIXTURE_MANIFEST = {
  id: PARCEL_FIXTURE_ID,
  name: "Acme Parcel",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A courier provider fixture for the plugin loaders.",
  author: { name: "Acme" },
  settings: [{ key: "secret", label: "API secret", type: "secret", required: true }],
  objects: {
    bookings: { name: "Bookings", fields: [{ key: "booking", name: "Booking", type: "json" }] },
    orders: { name: "Orders", fields: [{ key: "booking", name: "Booking", type: "json" }] },
  },
  providers: {
    courier: [{
      id: "parcel",
      name: "Acme Parcel",
      operations: ["findShipment", "verifyWebhook", "testConnection"],
      trackingUrl: "https://parcel.acme.test/t/{trackingId}",
    }],
  },
} as const;

export const PARCEL_FIXTURE_CODE = `
const manifest = ${JSON.stringify(PARCEL_FIXTURE_MANIFEST)};
function providerError(category, message, options = {}) {
  const error = new Error(message);
  error.name = "ProviderError";
  error.category = category;
  error.uncertain = options.uncertain === true;
  error.code = options.code;
  return error;
}
const AT = "2026-10-03T10:00:00+06:00";
export default {
  manifest,
  providers: {
    parcel: {
      kind: "courier",
      async createShipment(input, ctx) {
        if (input.orderId === "ORD-DECLINE") throw providerError("declined", "Acme Parcel does not deliver to this area.", { code: "parcel.area" });
        const existing = await ctx.objects.bookings.get(input.idempotencyKey);
        if (existing) return existing.booking;
        const booking = {
          externalId: "AP-" + input.orderId,
          trackingId: "TRK-" + input.orderId,
          status: "pending",
          rawStatus: "Booked",
          chargeMinor: 6000,
          label: null,
          details: { zone: input.recipient.zoneName, codMinor: input.codAmountMinor, items: input.itemCount },
        };
        await ctx.objects.bookings.put(input.idempotencyKey, { booking });
        await ctx.objects.orders.put(input.orderId, { booking });
        if (input.orderId === "ORD-TIMEOUT") {
          throw providerError("retryable", "Acme Parcel did not answer; key " + ctx.settings.secret, { uncertain: true, code: "parcel.timeout" });
        }
        return booking;
      },
      async trackShipment() {
        return { status: "in_transit", rawStatus: "On the way", updatedAt: AT, details: { hub: "Dhaka" } };
      },
      async findShipment(input, ctx) {
        const saved = await ctx.objects.orders.get(input.orderId);
        const booking = saved?.booking;
        if (!booking) return { found: false, message: "Acme Parcel has no booking for this order." };
        return { found: true, externalId: booking.externalId, tracking: { status: booking.status, rawStatus: booking.rawStatus, updatedAt: AT } };
      },
      async verifyWebhook(request, ctx) {
        if (request.headers["x-parcel-signature"] !== ctx.settings.secret) return { status: "invalid", reason: "Bad signature" };
        const body = JSON.parse(request.rawBody);
        if (body.state === "note") return { status: "ignored", reason: "A tracking note" };
        return {
          status: "update",
          eventId: body.id,
          externalId: body.consignment,
          tracking: { status: body.state, rawStatus: body.text, updatedAt: AT, details: { pushedBy: "acme" } },
        };
      },
      async testConnection(_input, ctx) {
        return { ok: ctx.settings.secret.length > 8, message: "Acme Parcel account connected." };
      },
    },
  },
};
`;
