// bKash (the Bangladesh pack's `bkash` feature): bKash Tokenized Checkout
// (v1.2.0-beta) as a hosted payment provider, built only on the public
// plugin contract.
//
// - Checkout (payments.ts): createSession creates one bKash payment per
//   attempt the platform claimed and sends the buyer to bKash's page.
// - Return (payments.ts): bKash sends the buyer back to the platform's
//   callback. The app completes the payment with its own server-to-server
//   Execute call (bKash charges nothing before it), or settles a cancelled,
//   failed or repeated return with Query Payment. The return's parameters
//   only name the payment to ask about.
// - Webhooks: none. bKash's merchant notifications travel through AWS SNS
//   and would need certificate-signature verification. They add nothing:
//   a Tokenized Checkout payment completes only when this app executes it,
//   so the return and the status query see every capture.
// - Refunds (refunds.ts): bKash's refund API, sent at most once per
//   idempotency key and probed, never resent, when an answer is lost.
// - Protocol (client.ts): settings, the cached grant token, error mapping.

import { definePaymentProvider, ProviderError } from "@scalius/plugin-sdk";
import { BKASH_HOSTS, createBkashClient } from "./client";
import { createSession, queryPayment, verifyReturn } from "./payments";
import { refund, refundStatus } from "./refunds";

export { BKASH_HOSTS };

/** Storage collections (the pack's `storage`). */
export const BKASH_STORAGE = {
  // paymentID → the attempt it pays; a retried session is found by its attempt.
  "bkash-payments": { indexes: ["attemptHash"] },
  // Hashed idempotency key → the refund sent; one bKash refund settles one Scalius refund.
  "bkash-refunds": { unique: ["refundTrxId"] },
};

/** The fields of the bKash setup sheet (`group: "bkash"`). */
export const BKASH_SETTINGS = [
  {
    key: "bkash_environment",
    label: "Environment",
    type: "select" as const,
    default: "sandbox",
    options: [
      { value: "sandbox", label: "Sandbox (test payments)" },
      { value: "live", label: "Live" },
    ],
    group: "bkash" as const,
    help: "Sandbox uses bKash's test system and test wallets. Switch to Live together with your live credentials.",
  },
  { key: "bkash_app_key", label: "App key", type: "text" as const, maxLength: 200, group: "bkash" as const, help: "From the bKash payment gateway (PGW) credentials bKash sent you." },
  { key: "bkash_app_secret", label: "App secret", type: "secret" as const, group: "bkash" as const },
  { key: "bkash_username", label: "Username", type: "text" as const, maxLength: 200, group: "bkash" as const },
  { key: "bkash_password", label: "Password", type: "secret" as const, group: "bkash" as const },
];

/** The payment provider declaration (`providers.payment[]`). */
export const BKASH_PROVIDER = {
  id: "bkash",
  name: "bKash",
  // The checkout mark: the logo cropped to its art.
  icon: "assets/bkash.svg",
  checkoutName: "bKash",
  flow: "hosted" as const,
  chargeCurrencies: ["BDT"],
  // No amountLimits: bKash sets per-transaction limits per merchant account and wallet type; it refuses
  // an amount outside them when the payment is created, and checkout reports that as declined.
  operations: ["verifyReturn" as const, "queryPayment" as const, "refund" as const, "refundStatus" as const, "testConnection" as const],
  settings: ["bkash_environment", "bkash_app_key", "bkash_app_secret", "bkash_username", "bkash_password"],
  environmentSetting: "bkash_environment",
};

/** testConnection makes one token grant. */
const CONNECTION_BUDGET_MS = 15_000;

export const bkashProviders = {
  bkash: definePaymentProvider({
    createSession,
    verifyReturn,
    queryPayment,
    refund,
    refundStatus,

    verifyWebhook: () => ({
      status: "ignored",
      reason: "bKash payments are confirmed on the buyer's return and by status queries.",
    }),

    async testConnection(_input, ctx) {
      try {
        const client = createBkashClient(ctx, CONNECTION_BUDGET_MS);
        await client.authenticate();
        return { ok: true, message: `Connected to bKash ${client.environment}.` };
      } catch (error) {
        // ProviderError messages are merchant-safe by construction: never a credential or a raw answer.
        if (error instanceof ProviderError) return { ok: false, message: error.message };
        throw error;
      }
    },
  }),
};
