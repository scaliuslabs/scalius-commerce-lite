import { defineMessages } from "./index";

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
    "shipment.pending": "Booked",
    "shipment.in_review": "In review",
    "shipment.picked_up": "Picked up",
    "shipment.in_transit": "In transit",
    "shipment.delivered": "Delivered",
    "shipment.cancelled": "Cancelled",
    "shipment.failed": "Failed",
    "shipment.delivery_failed": "Delivery failed",
    "shipment.returned": "Returned",
  },
  bn: {
    refreshShipment: "ডেলিভারি স্ট্যাটাস রিফ্রেশ করুন",
    lastChecked: "{time}-এ দেখা হয়েছে",
    neverChecked: "এখনো দেখা হয়নি",
    shipmentUpdated: "ডেলিভারি স্ট্যাটাস: {status}",
    shipmentUpToDate: "সব আপডেটেড আছে",
    shipmentRefreshFailed: "রিফ্রেশ হয়নি",
    "shipment.pending": "বুক হয়েছে",
    "shipment.in_review": "রিভিউতে আছে",
    "shipment.picked_up": "পিকআপ হয়েছে",
    "shipment.in_transit": "পথে আছে",
    "shipment.delivered": "ডেলিভারি হয়েছে",
    "shipment.cancelled": "বাতিল",
    "shipment.failed": "ব্যর্থ",
    "shipment.delivery_failed": "ডেলিভারি ব্যর্থ",
    "shipment.returned": "ফেরত এসেছে",
  },
});

export type ShipmentStatusMessageKey = keyof typeof shipmentStatusMessages.en;

type Translate = (key: ShipmentStatusMessageKey, vars?: Record<string, string | number>) => string;

/** Courier delivery status label, falling back to the raw status for new courier states. */
export function shipmentStatusLabel(t: Translate, status: string): string {
  const key = `shipment.${status.toLowerCase()}`;
  return key in shipmentStatusMessages.en ? t(key as ShipmentStatusMessageKey) : status.replace(/_/g, " ");
}
