import { defineMessages } from "./index";

/** A courier's shipment details on the order page ("Show details"), loaded with them. */
export const shipmentMetadataMessages = defineMessages({
  en: {
    consignmentId: "Consignment ID",
    trackingId: "Tracking ID",
    trackingCode: "Tracking code",
    merchantOrderId: "Merchant order ID",
    deliveryFee: "Delivery fee",
    collectedAmount: "Collected amount",
    codAmount: "Cash on delivery amount",
    reason: "Reason",
    trackingMessage: "Tracking message",
    courier: "Courier",
    provider: "Provider",
    lastUpdate: "Last update",
    unreadable: "The courier's details can't be read.",
  },
  bn: {
    consignmentId: "কনসাইনমেন্ট আইডি",
    trackingId: "ট্র্যাকিং আইডি",
    trackingCode: "ট্র্যাকিং কোড",
    merchantOrderId: "মার্চেন্ট অর্ডার আইডি",
    deliveryFee: "ডেলিভারি চার্জ",
    collectedAmount: "আদায় করা টাকা",
    codAmount: "ক্যাশ অন ডেলিভারির টাকা",
    reason: "কারণ",
    trackingMessage: "ট্র্যাকিং বার্তা",
    courier: "কুরিয়ার",
    provider: "প্রোভাইডার",
    lastUpdate: "সর্বশেষ আপডেট",
    unreadable: "কুরিয়ারের তথ্য পড়া যাচ্ছে না।",
  },
});
