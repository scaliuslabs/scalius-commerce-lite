import type { ShipmentStatus } from "@scalius/shared/shipment-state";
import { defineMessages } from "./index";

type ShipmentWords = Record<`shipment.${ShipmentStatus}`, string>;

/** A word for every shipment state in every language: a state added without one does not compile. */
const SHIPMENT_WORDS = {
  en: {
    "shipment.creating": "Booking",
    "shipment.processing": "Booking",
    "shipment.reconcile_required": "Needs checking",
    "shipment.pending": "Booked",
    "shipment.pickup_assigned": "Pickup assigned",
    "shipment.picked_up": "Picked up",
    "shipment.pickup_failed": "Pickup failed",
    "shipment.in_transit": "In transit",
    "shipment.out_for_delivery": "Out for delivery",
    "shipment.on_hold": "On hold",
    "shipment.delivery_failed": "Delivery failed",
    "shipment.unknown": "Status unknown",
    "shipment.delivered": "Delivered",
    "shipment.partial_delivered": "Partly delivered",
    "shipment.returned": "Returned",
    "shipment.cancelled": "Cancelled",
    "shipment.failed": "Failed",
  } satisfies ShipmentWords,
  bn: {
    "shipment.creating": "বুক করা হচ্ছে",
    "shipment.processing": "বুক করা হচ্ছে",
    "shipment.reconcile_required": "যাচাই করা দরকার",
    "shipment.pending": "বুক হয়েছে",
    "shipment.pickup_assigned": "পিকআপ নির্ধারিত",
    "shipment.picked_up": "পিকআপ হয়েছে",
    "shipment.pickup_failed": "পিকআপ ব্যর্থ",
    "shipment.in_transit": "পথে আছে",
    "shipment.out_for_delivery": "ডেলিভারির পথে",
    "shipment.on_hold": "হোল্ডে আছে",
    "shipment.delivery_failed": "ডেলিভারি ব্যর্থ",
    "shipment.unknown": "স্ট্যাটাস অজানা",
    "shipment.delivered": "ডেলিভারি হয়েছে",
    "shipment.partial_delivered": "আংশিক ডেলিভারি হয়েছে",
    "shipment.returned": "ফেরত এসেছে",
    "shipment.cancelled": "বাতিল",
    "shipment.failed": "ব্যর্থ",
  } satisfies ShipmentWords,
};

/**
 * A courier parcel's status and its refresh, said by the order page's Delivery
 * card and the orders list: apart from the list's own catalog, which the order
 * page would otherwise download for these words.
 */
export const shipmentStatusMessages = defineMessages({
  en: {
    refreshShipment: "Refresh delivery status",
    lastChecked: "Checked {time}",
    neverChecked: "Not checked yet",
    shipmentUpdated: "Delivery status: {status}",
    shipmentUpToDate: "Already up to date",
    shipmentRefreshFailed: "Refresh failed",
    ...SHIPMENT_WORDS.en,
  },
  bn: {
    refreshShipment: "ডেলিভারি স্ট্যাটাস রিফ্রেশ করুন",
    lastChecked: "{time}-এ দেখা হয়েছে",
    neverChecked: "এখনো দেখা হয়নি",
    shipmentUpdated: "ডেলিভারি স্ট্যাটাস: {status}",
    shipmentUpToDate: "সব আপডেটেড আছে",
    shipmentRefreshFailed: "রিফ্রেশ হয়নি",
    ...SHIPMENT_WORDS.bn,
  },
});

export type ShipmentStatusMessageKey = keyof typeof shipmentStatusMessages.en;

type Translate = (key: ShipmentStatusMessageKey, vars?: Record<string, string | number>) => string;

/** Courier delivery status label, falling back to the raw status for new courier states. */
export function shipmentStatusLabel(t: Translate, status: string): string {
  const key = `shipment.${status.toLowerCase()}`;
  return key in shipmentStatusMessages.en ? t(key as ShipmentStatusMessageKey) : status.replace(/_/g, " ");
}
