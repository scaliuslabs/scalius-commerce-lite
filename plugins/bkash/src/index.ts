// Scalius bKash (`scalius.bkash`): bKash Tokenized Checkout (v1.2.0-beta) as
// a hosted payment provider, built only on the public plugin contract.
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

import {
  definePaymentProvider,
  definePlugin,
  PLUGIN_API_VERSION,
  ProviderError,
  type PluginManifestInput,
} from "@scalius/plugin-sdk";
import { BKASH_HOSTS, createBkashClient } from "./client";
import { createSession, queryPayment, verifyReturn } from "./payments";
import { refund, refundStatus } from "./refunds";

export const manifest = {
  id: "scalius.bkash",
  name: "bKash",
  version: "0.1.2",
  apiVersion: PLUGIN_API_VERSION,
  description: "Take bKash payments at checkout. Buyers pay on bKash's own page; an order is marked paid only after bKash confirms the payment to Scalius directly. Refund bKash payments from the order page.",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  tagline: "Take bKash payments at checkout",
  categories: ["payments"],
  countries: ["BD"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  documentationUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/blob/mono-repo/plugins/bkash/README.md",
  changelogUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/commits/mono-repo/plugins/bkash",
  minPlatformVersion: "1.0.0",
  allowedHosts: [BKASH_HOSTS.sandbox, BKASH_HOSTS.live],
  settings: [
    {
      key: "environment",
      label: "Environment",
      type: "select",
      default: "sandbox",
      options: [
        { value: "sandbox", label: "Sandbox (test payments)" },
        { value: "live", label: "Live" },
      ],
      help: "Sandbox uses bKash's test system and test wallets. Switch to Live together with your live credentials.",
    },
    { key: "app_key", label: "App key", type: "text", required: true, maxLength: 200, help: "From the bKash payment gateway (PGW) credentials bKash sent you." },
    { key: "app_secret", label: "App secret", type: "secret", required: true },
    { key: "username", label: "Username", type: "text", required: true, maxLength: 200 },
    { key: "password", label: "Password", type: "secret", required: true },
  ],
  storage: {
    // paymentID → the attempt it pays; a retried session is found by its attempt.
    payments: { indexes: ["attemptHash"] },
    // Hashed idempotency key → the refund sent; one bKash refund settles one Scalius refund.
    refunds: { unique: ["refundTrxId"] },
  },
  providers: {
    payment: [{
      id: "bkash",
      name: "bKash",
      // The checkout mark: the logo cropped to its art (the listing icon keeps the padded canvas).
      icon: "assets/mark.svg",
      checkoutName: "bKash",
      flow: "hosted",
      chargeCurrencies: ["BDT"],
      // No amountLimits: bKash sets per-transaction limits per merchant account and wallet type; it refuses
      // an amount outside them when the payment is created, and checkout reports that as declined.
      operations: ["verifyReturn", "queryPayment", "refund", "refundStatus", "testConnection"],
    }],
  },
  // A return may grant a token, Execute and Query in turn, and bKash can be slow: allow the platform's full 30 s.
  limits: { wallMs: 30_000 },
  translations: {
    bn: {
      name: "বিকাশ",
      tagline: "চেকআউটে বিকাশ পেমেন্ট নিন",
      description: "চেকআউটে বিকাশে পেমেন্ট নিন। ক্রেতা বিকাশের নিজের পেজে পেমেন্ট করেন; বিকাশ সরাসরি Scalius-কে পেমেন্ট নিশ্চিত করার পরই অর্ডার পেইড হয়। অর্ডার পেজ থেকে বিকাশ পেমেন্ট রিফান্ড করুন।",
    },
  },
} satisfies PluginManifestInput;

/** testConnection makes one token grant. */
const CONNECTION_BUDGET_MS = 15_000;

export default definePlugin({
  manifest,
  providers: {
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
  },
});
