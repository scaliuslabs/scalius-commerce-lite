// An SMS, email and fraud provider app written without the SDK, run by the
// bundled loader in the messaging and fraud port tests: it sends idempotently
// (its own objects, keyed by the platform's idempotency key), fails in the
// ways the ports define (the message text picks the failure), and reads its
// secret setting.

import { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";

export const NOTIFY_FIXTURE_ID = "acme.notify";
export const NOTIFY_FIXTURE_SECRET = "notify-fixture-api-key-0123456789";

export const NOTIFY_FIXTURE_MANIFEST = {
  id: NOTIFY_FIXTURE_ID,
  name: "Acme Notify",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "An SMS, email and fraud check provider fixture.",
  author: { name: "Acme" },
  // SMS and fraud checks carry the phone, email the address (COMMERCE-HOOKS H5).
  scopes: ["read_customer_emails", "read_customer_phones"],
  settings: [{ key: "api_key", label: "API key", type: "secret", required: true }],
  objects: { sent: { name: "Sent messages", fields: [{ key: "answer", name: "Answer", type: "json" }] } },
  providers: {
    sms: [{ id: "texts", name: "Acme Texts", operations: ["testConnection"] }],
    email: [{ id: "mail", name: "Acme Mail" }],
    courier_history: [{ id: "radar", name: "Acme Radar", operations: ["testConnection"] }],
  },
} as const;

/** The module source (ES module, no imports). */
export const NOTIFY_FIXTURE_CODE = `
const manifest = ${JSON.stringify(NOTIFY_FIXTURE_MANIFEST)};
function providerError(category, message, options = {}) {
  const error = new Error(message);
  error.name = "ProviderError";
  error.category = category;
  error.uncertain = options.uncertain === true;
  error.code = options.code;
  return error;
}
async function sendOnce(ctx, key, prefix, recipient) {
  if (key) {
    const sent = await ctx.objects.sent.get(key);
    if (sent) return sent.answer;
  }
  const answer = { success: true, providerRef: prefix + "-" + (key ? key.slice(0, 12) : "unkeyed"), rawStatus: "Queued for " + recipient };
  if (key) await ctx.objects.sent.put(key, { answer });
  return answer;
}
function failure(text, ctx) {
  if (text.includes("[declined]")) throw providerError("declined", "The number was refused.", { code: "acme_refused" });
  if (text.includes("[busy]")) throw providerError("retryable", "The gateway is busy.", { code: "acme_busy" });
  if (text.includes("[timeout]")) throw providerError("retryable", "Timed out after sending; key " + ctx.settings.api_key, { uncertain: true, code: "acme_timeout" });
  if (text.includes("[rejected-key]")) throw providerError("misconfigured", "The API key was rejected.", { code: "acme_key" });
  if (text.includes("[crash]")) throw new TypeError("boom");
}
export default {
  manifest,
  providers: {
    texts: {
      kind: "sms",
      async send(input, ctx) {
        failure(input.text, ctx);
        return sendOnce(ctx, input.idempotencyKey, "T", input.to);
      },
      async testConnection(_input, ctx) {
        return { ok: ctx.settings.api_key.length > 8, message: "API key saved." };
      },
    },
    mail: {
      kind: "email",
      async send(input, ctx) {
        failure(input.subject, ctx);
        return sendOnce(ctx, input.idempotencyKey, "M", input.to);
      },
    },
    radar: {
      kind: "courier_history",
      async check(input) {
        if (input.phone === "+8801999999999") throw providerError("declined", "Acme Radar has no history for this number.");
        return { riskLevel: "medium", phone: input.phone, totalParcels: 5, delivered: 3, cancelled: 2, couriers: { Pathao: { totalParcels: 5, delivered: 3, cancelled: 2 } } };
      },
      async testConnection(_input, ctx) {
        return { ok: true, message: "Radar reachable." };
      },
    },
  },
};
`;
