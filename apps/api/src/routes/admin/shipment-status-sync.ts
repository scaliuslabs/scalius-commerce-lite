import type { Database } from "@scalius/database/client";
import { deliveryShipments } from "@scalius/database/schema";
import {
  checkShipmentStatus,
  getDeliveryProvider,
  getShipment,
  type CourierProvidersSource,
  type ShipmentView,
  updateOrderStatusFromShipment,
} from "@scalius/core/modules/delivery";
import { assertNoActiveRefundAttempt, assertNoActivePaymentSessionAttempt } from "@scalius/core/modules/order-kernel";
import { eq } from "drizzle-orm";
import { syncCourierFulfilmentFromShipment } from "@scalius/core/modules/fulfilment";
import { NotFoundError } from "../../utils/api-error";

import {
  sendOrderStatusChangeNotification,
  type OrderNotificationResult,
  type OrderStatusChange,
} from "../../utils/order-notifications";
import { notificationSender } from "../../background/notification-sender";

type RequestContext = {
  env: Env;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
};

export type SyncedShipmentStatusPayload = Omit<ShipmentView, "lastChecked"> & {
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
  notificationResult: OrderNotificationResult | null;
};

export async function checkAndSyncShipmentStatus(options: {
  db: Database;
  shipment: ShipmentView;
  encryptionKey?: string;
  /** The request's couriers (app couriers join here). */
  couriers: CourierProvidersSource;
  c: RequestContext;
  source: string;
}): Promise<SyncedShipmentStatusResult> {
  const { db, shipment, encryptionKey, couriers, c, source } = options;
  const previousStatus = shipment.status;

  await assertNoActiveRefundAttempt(db, shipment.orderId);
  await assertNoActivePaymentSessionAttempt(db, shipment.orderId);

  const checkedShipment = await checkShipmentStatus(db, shipment.id, encryptionKey, couriers);
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

  // The ledger follows the parcel (F11): before the order moves for units
  // the courier holds, after it for units the courier never took.
  await syncCourierFulfilmentFromShipment(db, shipment.id, updatedShipment.status);
  const orderSync = await updateOrderStatusFromShipment(
    db,
    shipment.id,
    updatedShipment.status,
  );
  await syncCourierFulfilmentFromShipment(db, shipment.id, updatedShipment.status);
  const orderStatusChange = orderSync?.statusChange ?? null;

  const notificationResult = await sendOrderStatusChangeNotification({
    db,
    send: notificationSender(c),
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
