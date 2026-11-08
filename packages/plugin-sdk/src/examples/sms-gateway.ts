// A provider: the store sends its order messages and sign-in codes through this SMS gateway.
import { defineManifest, defineSmsProvider, definePlugin, PLUGIN_API_VERSION, ProviderError } from "@scalius/plugin-sdk";

export const manifest = defineManifest({
  id: "acme.sms",
  name: "Acme SMS",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Sends the store's text messages through Acme SMS.",
  author: { name: "Acme" },
  // An SMS gateway receives buyers' phone numbers: it must ask for them.
  scopes: ["read_customer_phones"],
  allowedHosts: ["api.acme-sms.example"],
  settings: [{ key: "api_key", label: "API key", type: "secret", required: true }],
  providers: {
    // Declared by port; `id` names the implementation below.
    sms: [{ id: "gateway", name: "Acme SMS", dedupesOnIdempotencyKey: true }],
  },
});

export default definePlugin({
  manifest,
  // Keyed by the provider's id from the manifest, whatever its port.
  providers: {
    gateway: defineSmsProvider({
      async send({ to, text, idempotencyKey }, ctx) {
        const apiKey = ctx.settings.api_key;
        if (!apiKey) throw new ProviderError("misconfigured", "Enter the Acme SMS API key.");
        let response;
        try {
          response = await ctx.http.fetch("https://api.acme-sms.example/v1/messages", {
            method: "POST",
            // The gateway applies a repeat of one key once: what `dedupesOnIdempotencyKey` promises.
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
            body: JSON.stringify({ to, text }),
          });
        } catch {
          // The message may have gone: the platform resends it under the same key.
          throw new ProviderError("retryable", "Acme SMS could not be reached.", { uncertain: true });
        }
        if (response.status === 401) throw new ProviderError("misconfigured", "Acme SMS refused the API key.");
        const body = JSON.parse(await response.text()) as { id?: string; error?: string };
        if (response.ok && body.id) return { success: true, providerRef: body.id };
        // A 4xx (an invalid number) never succeeds on a retry.
        return { success: false, rawStatus: body.error ?? `HTTP ${response.status}`, retryable: response.status >= 500 };
      },
    }),
  },
});
