// Payout provider callbacks (the payout port's `verifyWebhook`):
//
//   POST /webhooks/payouts/{provider}   an app payout provider (`<plugin id>:<provider id>`)
//
// The app authenticates the callback before anything changes (its secret or
// signature, from its own settings). Each update names a payout of that
// provider only (by the platform's payout id or the provider's reference)
// and is applied forward only (core `applyPayoutCallback`): an unknown
// payout is ignored, and a duplicate or older update changes nothing, so a
// provider may resend freely. Only the port's validated answer is applied,
// never the raw body.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Database } from "@scalius/database/client";
import { applyPayoutCallback } from "@scalius/core/modules/payouts";
import {
  isQualifiedProviderId,
  payoutWebhookSchema,
  providerErrorOf,
  type PayoutWebhook,
  type ProviderHttpRequest,
} from "@scalius/shared/plugins/providers";
import { assertAppProviderInstalled, requestAppProviders } from "../../plugins/providers/app-providers";

const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/** The callback as the port carries it: the exact body, and only headers and query values within its bounds. */
async function toProviderRequest(c: Context): Promise<ProviderHttpRequest> {
  const headers: Record<string, string> = {};
  for (const [name, value] of c.req.raw.headers) {
    if (HEADER_NAME.test(name) && value.length <= 8192) headers[name] = value;
  }
  const query = Object.fromEntries(
    Object.entries(c.req.query()).filter(([key, value]) => key.length <= 128 && value.length <= 8192),
  );
  return { method: c.req.method, rawBody: await c.req.text(), headers, query };
}

async function handlePayoutWebhook(c: Context<{ Bindings: Env }>, providerId: string): Promise<Response> {
  const choice = await requestAppProviders(c as never).resolve("payout", providerId);
  const provider = choice.provider;
  if (!provider) {
    // No installed app declares it: nothing here. Installed but not ready (inactive, not set up): the provider comes back.
    const installed = await assertAppProviderInstalled(c.get("db") as Database, "payout", providerId).then(() => true, () => false);
    if (!installed) return c.json({ error: "Not found" }, 404);
    console.warn(`[payout-webhook] ${providerId} is not ready`);
    return c.json({ error: "Webhook verification unavailable" }, 503);
  }
  if (!provider.verifyWebhook) return c.json({ error: "Not found" }, 404);

  let verification: PayoutWebhook;
  try {
    const answer = payoutWebhookSchema.safeParse(await provider.verifyWebhook(await toProviderRequest(c), { signal: AbortSignal.timeout(10_000) }));
    if (!answer.success) {
      console.warn(`[payout-webhook] ${providerId} answered outside the port`);
      return c.json({ error: "Unauthorized" }, 401);
    }
    verification = answer.data;
  } catch (error) {
    const failure = providerErrorOf(error);
    if (failure?.category === "declined") {
      console.warn(`[payout-webhook] ${providerId} rejected (${failure.code})`);
      return c.json({ error: "Unauthorized" }, 401);
    }
    // A missing secret or an unavailable check: nothing was applied, the provider comes back.
    console.error(`[payout-webhook] ${providerId} verification unavailable (${failure?.code ?? "provider_call_failed"})`);
    return c.json({ error: "Webhook verification unavailable" }, 503);
  }
  if (verification.status === "invalid") {
    console.warn(`[payout-webhook] ${providerId} rejected an unauthenticated callback`);
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (verification.status === "ignored") return c.json({ received: true });

  const db = c.get("db") as Database;
  const outcomes = { applied: 0, unchanged: 0, unknown: 0 };
  for (const update of verification.updates) {
    const outcome = await applyPayoutCallback(db, provider.id, {
      ...(update.payoutId ? { payoutId: update.payoutId } : {}),
      providerRef: update.providerRef,
      status: update.status,
      failureCode: update.failureCode ?? null,
      failureMessage: update.reason ?? null,
    });
    outcomes[outcome] += 1;
  }
  return c.json({ received: true, ...outcomes });
}

const app = new OpenAPIHono<{ Bindings: Env }>();
app.post("/:provider", async (c): Promise<Response> => {
  const providerId = c.req.param("provider");
  if (!isQualifiedProviderId(providerId)) return c.json({ error: "Not found" }, 404);
  return handlePayoutWebhook(c, providerId);
});
export const payoutWebhookRoutes = app;
