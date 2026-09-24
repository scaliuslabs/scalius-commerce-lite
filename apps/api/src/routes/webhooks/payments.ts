// POST /webhooks/{provider} for every payment gateway. The adapter
// authenticates the callback (signature or server-to-server validation)
// before any state changes; the kernel claims the provider event once and
// hands it to the queue. Configure this URL in the provider dashboard.

import { OpenAPIHono } from "@hono/zod-openapi";
import { getPaymentGateway } from "@scalius/core/modules/payments";
import { claimAndEnqueuePaymentEvent, loadCallbackSettings, toGatewayRequest } from "../payment/payment-events";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.post("/:provider", async (c) => {
  const gateway = getPaymentGateway(c.req.param("provider"));
  if (!gateway) return c.json({ error: "Not found" }, 404);
  const db = c.get("db");

  const loaded = await loadCallbackSettings(gateway, db, c.env);
  if (loaded.status === "unavailable") return c.json({ error: "Webhook settings unavailable" }, 503);
  if (loaded.status === "skipped") {
    console.warn(`[payment-webhook] ${gateway.id} is not configured to verify callbacks; ignoring event`);
    return c.json({ received: true, skipped: true });
  }

  const verification = await gateway.verifyWebhook(loaded.settings, await toGatewayRequest(c));
  if (verification.status === "invalid") {
    console.warn(`[payment-webhook] ${gateway.id} rejected: ${verification.reason}`);
    return c.json({ error: "Invalid signature" }, 400);
  }
  if (verification.status === "retry") {
    console.error(`[payment-webhook] ${gateway.id} verification unavailable: ${verification.reason}`);
    return c.json({ error: "Webhook verification unavailable" }, 503);
  }
  if (verification.status === "ignored") return c.json({ received: true });

  const claim = await claimAndEnqueuePaymentEvent({
    db,
    queue: c.env.JOBS_QUEUE,
    provider: gateway.id,
    event: verification.event,
    source: "webhook",
  });
  if (claim.status === "retry") return c.json({ error: "Failed to enqueue payment event" }, 503);
  if (claim.status === "duplicate") {
    return c.json({ received: true, skipped: true, duplicate: true, status: claim.existingStatus });
  }
  return c.json({ received: true });
});

export const paymentWebhookRoutes = app;
