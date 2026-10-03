// POST /webhooks/couriers/{provider}: tracking pushes for app couriers
// (`<plugin id>:<provider id>`) that implement the port's `verifyWebhook`.
// Pathao and Steadfast keep their own routes (their pushes need courier-
// specific answers). The app authenticates the push before anything changes;
// the push is claimed once in webhook_events (event type `courier.<status>`,
// which the payment webhook sweep excludes) and applied through the same
// shipment, fulfilment ledger and order sync as the built-in courier routes.
// Only the port's validated answer is applied: a status from the port's set,
// short audit details, never the raw body.

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { deliveryProviders, deliveryShipments } from "@scalius/database/schema";
import { courierFor, updateOrderStatusFromShipment } from "@scalius/core/modules/delivery";
import { syncCourierFulfilmentFromShipment } from "@scalius/core/modules/fulfilment";
import {
  isQualifiedProviderId,
  providerErrorOf,
  type CourierWebhook,
  type ProviderHttpRequest,
} from "@scalius/shared/plugins/providers";
import { requestCourierProviders } from "../../plugins/providers/courier";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { enqueueOrderStatusChangeNotification } from "../../utils/order-notification-queue";
import {
  buildWebhookEventId,
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventProcessed,
} from "../../utils/webhook-idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/** The push as the port carries it: the exact body, and only headers and query values within its bounds. */
async function toCourierRequest(c: Context): Promise<ProviderHttpRequest> {
  const headers: Record<string, string> = {};
  for (const [name, value] of c.req.raw.headers) {
    if (HEADER_NAME.test(name) && value.length <= 8192) headers[name] = value;
  }
  const query = Object.fromEntries(
    Object.entries(c.req.query()).filter(([key, value]) => key.length <= 128 && value.length <= 8192),
  );
  return { method: c.req.method, rawBody: await c.req.text(), headers, query };
}

function parseMetadata(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

app.post("/:provider", async (c) => {
  const courierId = c.req.param("provider");
  if (!isQualifiedProviderId(courierId)) return c.json({ error: "Not found" }, 404);
  const courier = await courierFor(requestCourierProviders(c), courierId);
  if (!courier?.verifyWebhook) return c.json({ error: "Not found" }, 404);
  const db = c.get("db");

  // Exactly one active row uses this courier: shipments are scoped to it, as for the built-in routes.
  const rows = await db.select().from(deliveryProviders)
    .where(and(eq(deliveryProviders.type, courier.id), eq(deliveryProviders.isActive, true)))
    .orderBy(desc(deliveryProviders.updatedAt))
    .limit(2);
  if (rows.length !== 1) {
    console.warn(`[courier-webhook] ${courier.id} rejected: ${rows.length === 0 ? "no active provider" : "several active providers"}`);
    return c.json({ error: "Unauthorized" }, 401);
  }
  const provider = rows[0]!;

  const setup = await courier.setup(provider, getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>));
  if (setup.settings === null) {
    console.error(`[courier-webhook] ${courier.id} settings are not readable`);
    return c.json({ error: "Webhook settings unavailable" }, 503);
  }

  let verification: CourierWebhook;
  try {
    verification = await courier.verifyWebhook(await toCourierRequest(c), {
      settings: setup.settings,
      signal: new AbortController().signal,
      db,
    });
  } catch (error) {
    const failure = providerErrorOf(error);
    if (!failure) throw error;
    if (failure.category === "declined") {
      console.warn(`[courier-webhook] ${courier.id} rejected (${failure.code})`);
      return c.json({ error: "Unauthorized" }, 401);
    }
    // The courier comes back: nothing was applied.
    console.error(`[courier-webhook] ${courier.id} verification unavailable (${failure.code})`);
    return c.json({ error: "Webhook verification unavailable" }, 503);
  }
  if (verification.status === "invalid") {
    console.warn(`[courier-webhook] ${courier.id} rejected an unauthenticated push`);
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (verification.status === "ignored") return c.json({ received: true });

  const { externalId, tracking } = verification;
  const shipment = await db.select().from(deliveryShipments).where(and(
    eq(deliveryShipments.externalId, externalId),
    eq(deliveryShipments.providerType, courier.id),
    eq(deliveryShipments.providerId, provider.id),
  )).get();
  if (!shipment) return c.json({ received: true, ignored: true });

  // The courier's own event id when it sends one, else the state it reports at its time.
  const sourceEventId = verification.eventId
    ? `${externalId}:${verification.eventId}`
    : `${externalId}:${tracking.status}:${tracking.rawStatus}:${tracking.updatedAt}`;
  const eventType = `courier.${tracking.status}`;
  const eventId = buildWebhookEventId(courier.id, eventType, sourceEventId);
  const claim = await claimWebhookEvent(db, {
    id: eventId,
    provider: courier.id,
    eventType,
    orderId: shipment.orderId,
    status: "processing",
    result: { externalId, rawStatus: tracking.rawStatus },
  });
  if (!claim.claimed) {
    return c.json({ received: true, duplicate: true, status: claim.existing?.status ?? "unknown" });
  }

  try {
    await db.update(deliveryShipments).set({
      status: tracking.status,
      rawStatus: tracking.rawStatus,
      lastChecked: new Date(),
      updatedAt: new Date(),
      metadata: JSON.stringify({
        ...parseMetadata(shipment.metadata),
        ...(tracking.details ?? {}),
        lastWebhookAt: new Date().toISOString(),
      }),
    }).where(eq(deliveryShipments.id, shipment.id));

    // The ledger follows the parcel (F11): before the order moves for units
    // the courier holds, after it for units the courier never took.
    await syncCourierFulfilmentFromShipment(db, shipment.id, tracking.status);
    const statusResult = await updateOrderStatusFromShipment(db, shipment.id, tracking.status);
    await syncCourierFulfilmentFromShipment(db, shipment.id, tracking.status);
    await enqueueOrderStatusChangeNotification({
      db,
      queue: c.env.JOBS_QUEUE,
      statusChange: statusResult?.statusChange ?? null,
      trackingId: shipment.trackingId,
      source: "courier-webhook",
    });

    await markWebhookEventProcessed(db, eventId, {
      externalId,
      status: tracking.status,
      rawStatus: tracking.rawStatus,
      previousStatus: shipment.status,
    });
    return c.json({ received: true, status: tracking.status });
  } catch (error) {
    console.error(`[courier-webhook] ${courier.id} processing failed`, { errorName: error instanceof Error ? error.name : typeof error });
    await markWebhookEventFailed(db, eventId, { error: "courier_webhook_processing_failed" });
    return c.json({ error: "Internal processing error" }, 500);
  }
});

export const courierWebhookRoutes = app;
