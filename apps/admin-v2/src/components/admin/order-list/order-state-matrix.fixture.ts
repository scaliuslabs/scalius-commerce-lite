// Test fixture: orders-list rows in every state combination that can co-occur.
// Every order status meets every payment and fulfilment status; every courier
// state meets every fulfilment type and channel; the flags (locks, requests,
// money owed back, failed cash attempts, junk and long names, long totals) are
// spread across them. Used by the list's render tests in both languages.
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import { FULFILLMENT_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from "@scalius/shared/order-state";

export const FULFILMENT_TYPES = ["ship", "pickup", "digital", "gift_card", "service"] as const;
export const SHIPMENT_STATES = [
  "none",
  "booked",
  "in_transit",
  "delivered",
  "failed",
  "returned_to_sender",
  "reconcile_required",
  "sync_in_progress",
] as const;
export const CHANNELS = [
  { channel: "online_store", channelSource: null },
  { channel: "admin", channelSource: "facebook" },
  { channel: "agent", channelSource: null },
  { channel: "app", channelSource: "acme-loyalty-points" },
] as const;
const COD = [null, { status: "pending", deliveryAttempts: 0 }, { status: "failed", deliveryAttempts: 2 }, { status: "collected", deliveryAttempts: 1 }] as const;
const NAMES = ["Rahim", "yjghhk jghjghj", "Mohammad Abdur Rahman Chowdhury Bhuiyan Talukder", "মোহাম্মদ আব্দুর রহমান চৌধুরী"];
const TOTALS = [680, 345345, 9999999.99, 1234.5];
const PAYMENT_RECOVERY = ["none", "awaiting_payment", "processing", "needs_attention"] as const;
const REQUESTS = [null, "cancel_pre_shipment", "return", "refund"] as const;

const NO_RECOVERY = { state: "none", severity: "info", activeLock: false } as const;

function shipmentFor(state: (typeof SHIPMENT_STATES)[number]) {
  const shipment = (status: string) => ({
    id: "shp_1", providerId: "prov_1", providerType: "pathao", providerName: "Pathao", status,
    rawStatus: null, externalId: "ext_1", trackingId: "TRK-1", lastChecked: null,
    updatedAt: new Date("2026-09-30T08:00:00Z"), createdAt: new Date("2026-09-30T08:00:00Z"),
  });
  switch (state) {
    case "none": return { latestShipment: null, shipmentRecovery: NO_RECOVERY };
    case "booked": return { latestShipment: shipment("pending"), shipmentRecovery: NO_RECOVERY };
    case "in_transit": return { latestShipment: shipment("in_transit"), shipmentRecovery: NO_RECOVERY };
    case "delivered": return { latestShipment: shipment("delivered"), shipmentRecovery: NO_RECOVERY };
    case "failed": return { latestShipment: shipment("delivery_failed"), shipmentRecovery: NO_RECOVERY };
    case "returned_to_sender": return { latestShipment: shipment("returned"), shipmentRecovery: NO_RECOVERY };
    case "reconcile_required":
      return {
        latestShipment: shipment("pending"),
        shipmentRecovery: { ...NO_RECOVERY, state: "needs_attention", severity: "danger", activeLock: true, status: "reconcile_required" },
      };
    case "sync_in_progress":
      return { latestShipment: null, shipmentRecovery: { ...NO_RECOVERY, state: "creating", severity: "info", activeLock: true } };
  }
}

function deliveryFor(type: (typeof FULFILMENT_TYPES)[number], index: number) {
  switch (type) {
    case "ship": return { requiresShipping: true, shippingMethodKind: "delivery", pickupReadyAt: null };
    case "pickup": return { requiresShipping: false, shippingMethodKind: "pickup", pickupReadyAt: index % 2 ? new Date("2026-09-30T09:00:00Z") : null };
    default: return { requiresShipping: false, shippingMethodKind: null, pickupReadyAt: null };
  }
}

export interface MatrixRow {
  label: string;
  order: OrderListItem;
}

function row(index: number, dims: {
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  type: (typeof FULFILMENT_TYPES)[number];
  shipment: (typeof SHIPMENT_STATES)[number];
  channel: (typeof CHANNELS)[number];
}): MatrixRow {
  const recovery = PAYMENT_RECOVERY[index % PAYMENT_RECOVERY.length]!;
  const order = {
    id: `ord_${index}`,
    orderNumber: 1000 + index,
    customerName: NAMES[index % NAMES.length]!,
    customerPhone: "+8801712345678",
    customerEmail: null,
    customerId: null,
    totalAmount: TOTALS[index % TOTALS.length]!,
    shippingCharge: 60,
    discountAmount: null,
    status: dims.status,
    paymentStatus: dims.paymentStatus,
    paidAmount: dims.paymentStatus === "paid" ? TOTALS[index % TOTALS.length]! : 0,
    paymentMethod: index % 3 === 0 ? "bkash" : "cod",
    fulfillmentStatus: dims.fulfillmentStatus,
    createdAt: new Date(Date.now() - (index % 5) * 3_600_000 * 7),
    updatedAt: new Date(),
    version: 1,
    itemCount: (index % 4) + 1,
    city: null, zone: null, area: null, cityName: null, zoneName: null, areaName: null,
    ...shipmentFor(dims.shipment),
    paymentRecovery: { state: recovery, label: "", message: null, gateway: "sslcommerz", paymentType: null, status: null, attempts: 0, activeProcessing: false, staleProcessing: false, updatedAt: null },
    activeRefundOperation: index % 11 === 0 ? { active: true, status: "processing", severity: index % 22 === 0 ? "danger" : "warning" } : null,
    archivedAt: null,
    channel: dims.channel.channel,
    channelSource: dims.channel.channelSource,
    openRequestType: REQUESTS[index % REQUESTS.length]!,
    cod: COD[index % COD.length]!,
    refundDue: index % 7 === 0 ? 450 : 0,
    refundedAmount: dims.paymentStatus.includes("refunded") ? 100 : 0,
    ...deliveryFor(dims.type, index),
  } as unknown as OrderListItem;
  return {
    label: `${dims.status}/${dims.paymentStatus}/${dims.fulfillmentStatus}/${dims.type}/${dims.shipment}/${dims.channel.channel}`,
    order,
  };
}

/** Every co-occurring combination of the list's dimensions (see the header). */
export function orderStateMatrix(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  let index = 0;
  // Every order status × payment × fulfilment status, the other dimensions turning over.
  for (const status of ORDER_STATUSES) {
    for (const paymentStatus of PAYMENT_STATUSES) {
      for (const fulfillmentStatus of FULFILLMENT_STATUSES) {
        rows.push(row(index, {
          status, paymentStatus, fulfillmentStatus,
          type: FULFILMENT_TYPES[index % FULFILMENT_TYPES.length]!,
          shipment: SHIPMENT_STATES[index % SHIPMENT_STATES.length]!,
          channel: CHANNELS[index % CHANNELS.length]!,
        }));
        index += 1;
      }
    }
  }
  // Every courier state × fulfilment type × channel, the statuses turning over.
  for (const shipment of SHIPMENT_STATES) {
    for (const type of FULFILMENT_TYPES) {
      for (const channel of CHANNELS) {
        rows.push(row(index, {
          status: ORDER_STATUSES[index % ORDER_STATUSES.length]!,
          paymentStatus: PAYMENT_STATUSES[index % PAYMENT_STATUSES.length]!,
          fulfillmentStatus: FULFILLMENT_STATUSES[index % FULFILLMENT_STATUSES.length]!,
          type, shipment, channel,
        }));
        index += 1;
      }
    }
  }
  return rows;
}
