// A payment provider app written without the SDK, run by both loaders in
// the provider tests (providers.bundled.test.ts, plugins.sandbox.test.ts):
// the same bytes, so both prove the same behaviour. It stores its sessions in
// its own storage (idempotent by attempt key), authenticates webhooks with
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
  storage: { sessions: { indexes: [], unique: [] } },
  providers: {
    payment: [{ id: "wallet", name: "Acme Wallet", flow: "instructions", chargeCurrencies: ["BDT"], operations: ["testConnection"] }],
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
        const existing = await ctx.storage.sessions.get(input.attemptKey);
        if (existing) return existing.session;
        const session = {
          providerRef: "W-" + input.correlationId,
          instructions: { title: "Send money", body: "Send " + input.wireAmount.decimal + " " + input.currency + " to 01700000000." },
        };
        await ctx.storage.sessions.put(input.attemptKey, { session, orderId: input.orderId });
        ctx.log.info("Session created", { orderId: input.orderId });
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
