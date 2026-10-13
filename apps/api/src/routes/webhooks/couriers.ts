// Courier tracking pushes (the courier port's `verifyWebhook`):
//
//   POST /webhooks/couriers/{provider}   an app courier (`<plugin id>:<provider id>`)
//
// The app authenticates the push before anything changes (its secret, header
// or signature, from its own settings). Exactly one active delivery provider
// row may use the courier, and shipments are scoped to it. A push is claimed
// once in webhook_events (event type `courier.<status>` or `courier.note`,
// which the payment webhook sweep excludes) and applied through the same
// shipment, fulfilment ledger and order sync as every courier. Only the
// port's validated answer is applied: a status from the port's set, short
// audit details, never the raw body. The courier's expected answer (status,
// headers, body: Pathao's integration secret header) comes from the app.

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { deliveryProviders, deliveryShipments } from "@scalius/database/schema";
import { courierFor, updateOrderStatusFromShipment } from "@scalius/core/modules/delivery";
import { syncCourierFulfilmentFromShipment } from "@scalius/core/modules/fulfilment";
import {
  isQualifiedProviderId,
  providerErrorOf,
  type CourierWebhook,
  type CourierWebhookReply,
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

type ShipmentRow = typeof deliveryShipments.$inferSelect;

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

/** The answer for an accepted push: the courier's expected reply, else a plain acknowledgement. */
function accepted(c: Context, reply: CourierWebhookReply | undefined, fallback: Record<string, unknown>): Response {
  if (!reply) return c.json(fallback);
  return c.json(reply.body ?? fallback, reply.status as 200, reply.headers ?? {});
}

const confirmedExisting = sql`CASE WHEN json_valid(${deliveryShipments.metadata}) THEN json_extract(${deliveryShipments.metadata}, '$.unknownOutcomeResolution.outcome') END = 'confirmed_existing'`;

/**
 * The shipment a push is about. By booking id; with the order number the
 * courier echoes, a booking id whose shipment belongs to another order is
 * refused, and a shipment of that order whose booking the courier confirmed
 * by lookup but whose id was never learned is bound to it (compare-and-set,
 * so a concurrent push binds it once).
 */
async function findPushShipment(
  db: Database,
  courierId: string,
  providerId: string,
  externalId: string,
  orderId: string | undefined,
): Promise<{ shipment: ShipmentRow | null; rejection?: "identity_conflict" | "ambiguous_recovery" }> {
  const scope = and(eq(deliveryShipments.providerType, courierId), eq(deliveryShipments.providerId, providerId));
  const exact = await db.select().from(deliveryShipments).where(and(eq(deliveryShipments.externalId, externalId), scope)).get();
  if (exact) {
    return orderId && exact.orderId !== orderId ? { shipment: null, rejection: "identity_conflict" } : { shipment: exact };
  }
  if (!orderId) return { shipment: null };

  const recovered = await db.select().from(deliveryShipments)
    .where(and(eq(deliveryShipments.orderId, orderId), scope, confirmedExisting))
    .limit(2);
  if (recovered.length !== 1) {
    return { shipment: null, rejection: recovered.length > 1 ? "ambiguous_recovery" : undefined };
  }
  const candidate = recovered[0]!;
  if (candidate.externalId) {
    return candidate.externalId === externalId ? { shipment: candidate } : { shipment: null, rejection: "identity_conflict" };
  }
  const bound = await db.update(deliveryShipments).set({ externalId, updatedAt: new Date() })
    .where(and(eq(deliveryShipments.id, candidate.id), eq(deliveryShipments.orderId, orderId), scope, isNull(deliveryShipments.externalId), confirmedExisting))
    .returning({ id: deliveryShipments.id });
  if (bound.length === 1) return { shipment: { ...candidate, externalId } };
  const concurrentlyBound = await db.select().from(deliveryShipments)
    .where(and(eq(deliveryShipments.id, candidate.id), eq(deliveryShipments.externalId, externalId), scope, confirmedExisting))
    .get();
  return concurrentlyBound ? { shipment: concurrentlyBound } : { shipment: null, rejection: "identity_conflict" };
}

/** Serves one courier's push. */
async function handleCourierWebhook(c: Context<{ Bindings: Env }>, courierId: string): Promise<Response> {
  const courier = await courierFor(requestCourierProviders(c), courierId);
  if (!courier?.verifyWebhook) return c.json({ error: "Not found" }, 404);
  const db = c.get("db") as Database;

  // Exactly one active row uses this courier: shipments are scoped to it.
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
    // A missing secret or an unavailable check: nothing was applied, the courier comes back.
    console.error(`[courier-webhook] ${courier.id} verification unavailable (${failure.code})`);
    return c.json({ error: "Webhook verification unavailable" }, 503);
  }
  if (verification.status === "invalid") {
    if (verification.rejectStatus) {
      console.warn(`[courier-webhook] ${courier.id} rejected a malformed push`);
      return c.json({ error: verification.reason }, verification.rejectStatus as 400);
    }
    console.warn(`[courier-webhook] ${courier.id} rejected an unauthenticated push`);
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (verification.status === "ignored") return accepted(c, verification.reply, { received: true });

  const { externalId, reply } = verification;
  const match = await findPushShipment(db, courier.id, provider.id, externalId, verification.orderId);
  if (match.rejection) console.warn(`[courier-webhook] ${courier.id} shipment match rejected: ${match.rejection}`);
  const shipment = match.shipment;
  if (!shipment) return accepted(c, reply, { received: true, ignored: true });

  if (verification.status === "note") {
    const eventId = buildWebhookEventId(courier.id, "courier.note", `${externalId}:${verification.eventId}`);
    const claim = await claimWebhookEvent(db, {
      id: eventId,
      provider: courier.id,
      eventType: "courier.note",
      orderId: shipment.orderId,
      status: "processing",
      result: { externalId },
    });
    if (!claim.claimed) return accepted(c, reply, { received: true, duplicate: true });
    try {
      await db.update(deliveryShipments).set({
        lastChecked: new Date(),
        metadata: JSON.stringify({ ...parseMetadata(shipment.metadata), ...verification.details }),
      }).where(eq(deliveryShipments.id, shipment.id));
      await markWebhookEventProcessed(db, eventId, { externalId });
      return accepted(c, reply, { received: true });
    } catch (error) {
      console.error(`[courier-webhook] ${courier.id} note failed`, { errorName: error instanceof Error ? error.name : typeof error });
      await markWebhookEventFailed(db, eventId, { error: "courier_webhook_processing_failed" });
      return c.json({ error: "Internal processing error" }, 500);
    }
  }

  const { tracking } = verification;
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
    return accepted(c, reply, { received: true, duplicate: true, status: claim.existing?.status ?? "unknown" });
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
    return accepted(c, reply, { received: true, status: tracking.status });
  } catch (error) {
    console.error(`[courier-webhook] ${courier.id} processing failed`, { errorName: error instanceof Error ? error.name : typeof error });
    await markWebhookEventFailed(db, eventId, { error: "courier_webhook_processing_failed" });
    return c.json({ error: "Internal processing error" }, 500);
  }
}

const app = new OpenAPIHono<{ Bindings: Env }>();
app.post("/:provider", async (c): Promise<Response> => {
  const courierId = c.req.param("provider");
  if (!isQualifiedProviderId(courierId)) return c.json({ error: "Not found" }, 404);
  return handleCourierWebhook(c, courierId);
});
export const courierWebhookRoutes = app;
