import type { Database } from "@scalius/database/client";
import type { DeliveryShipment } from "@scalius/database/schema";
import { deliveryShipments } from "@scalius/database/schema";
import { checkShipmentStatus, getDeliveryProvider, getShipment } from "@scalius/core/modules/delivery/delivery.service";
import { updateOrderStatusFromShipment } from "@scalius/core/modules/delivery/tracking";
import { assertNoActiveRefundAttempt, assertNoActivePaymentSessionAttempt } from "@scalius/core/modules/payments";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../utils/api-error";
import { invalidateProductAvailabilityCaches } from "../../utils/cache-invalidation";
import {
  enqueueOrderStatusChangeNotification,
  type EnqueueOrderNotificationResult,
  type OrderStatusChange,
} from "../../utils/order-notification-queue";

type RequestContext = {
  env: Env;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
};

export type SyncedShipmentStatusPayload = Omit<DeliveryShipment, "lastChecked"> & {
  providerName: string | null;
  providerType: string | null;
  lastChecked: string;
  statusChanged: boolean;
  orderStatusUpdate: boolean;
};

export type SyncedShipmentStatusResult = {
  payload: SyncedShipmentStatusPayload;
  previousStatus: string;
  orderStatusChange: OrderStatusChange | null | undefined;
  notificationResult: EnqueueOrderNotificationResult | null;
};

export async function checkAndSyncShipmentStatus(options: {
  db: Database;
  shipment: DeliveryShipment;
  encryptionKey?: string;
  c: RequestContext;
  source: string;
}): Promise<SyncedShipmentStatusResult> {
  const { db, shipment, encryptionKey, c, source } = options;
  const previousStatus = shipment.status;

  await assertNoActiveRefundAttempt(db, shipment.orderId);
  await assertNoActivePaymentSessionAttempt(db, shipment.orderId);

  const checkedShipment = await checkShipmentStatus(db, shipment.id, encryptionKey);
  const now = new Date();

  await db
    .update(deliveryShipments)
    .set({ lastChecked: now })
    .where(eq(deliveryShipments.id, shipment.id));

  const updatedShipment = await getShipment(db, shipment.id);
  if (!updatedShipment) {
    throw new NotFoundError("Failed to retrieve updated shipment");
  }

  const provider = updatedShipment.providerId
    ? await getDeliveryProvider(db, updatedShipment.providerId)
    : null;

  const orderSync = await updateOrderStatusFromShipment(
    db,
    shipment.id,
    updatedShipment.status,
  );
  const orderStatusChange = orderSync?.statusChange ?? null;

  if (
    orderSync
    && Array.isArray(orderSync.availabilityTransitionVariantIds)
    && orderSync.availabilityTransitionVariantIds.length > 0
  ) {
    await invalidateProductAvailabilityCaches(
      db,
      { variantIds: orderSync.availabilityTransitionVariantIds },
      c,
    );
  }

  const notificationResult = await enqueueOrderStatusChangeNotification({
    db,
    queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
    statusChange: orderStatusChange,
    trackingId:
      updatedShipment.trackingId ??
      checkedShipment.trackingId ??
      shipment.trackingId,
    source,
  });

  return {
    payload: {
      ...updatedShipment,
      providerName: provider?.name ?? null,
      providerType: updatedShipment.providerType ?? null,
      lastChecked: now.toISOString(),
      statusChanged: previousStatus !== updatedShipment.status,
      orderStatusUpdate: Boolean(orderStatusChange?.orderId),
    },
    previousStatus,
    orderStatusChange,
    notificationResult,
  };
}
