import { isOrderChannelSourcePreset, type OrderChannel } from "@scalius/shared/order-channel";
import { appPaymentMethodName } from "~/lib/app-payment-method";
import { defineMessages } from "./index";

/**
 * Words shared by every order screen: statuses, payment and delivery states.
 * Screen-specific copy lives in `order-list.ts`, `order-detail.ts` and
 * `order-form.ts`.
 */
export const orderMessages = defineMessages({
  en: {
    "status.pending": "Pending",
    "status.processing": "Processing",
    "status.confirmed": "Confirmed",
    "status.shipped": "Shipped",
    "status.delivered": "Delivered",
    "status.completed": "Completed",
    "status.cancelled": "Cancelled",
    "status.refunded": "Refunded",
    "status.returned": "Returned",
    "status.incomplete": "Incomplete",
    "payment.unpaid": "Unpaid",
    "payment.partial": "Partly paid",
    "payment.paid": "Paid",
    "payment.partially_refunded": "Partially refunded",
    "payment.refunded": "Refunded",
    "payment.failed": "Payment failed",
    "fulfillment.pending": "Unfulfilled",
    "fulfillment.partial": "Partly fulfilled",
    "fulfillment.complete": "Fulfilled",
    "method.cod": "Cash on delivery",
    "method.stripe": "Card (Stripe)",
    "method.gift_card": "Gift card",
    "request.cancel_pre_shipment": "Cancellation requested",
    "request.return": "Return requested",
    "request.refund": "Refund requested",
    refundOwed: "Refund owed",
    refundOwedAmount: "Refund owed {amount}",
    archived: "Archived",
    orders: "Orders",
    order: "Order {number}",
    "delivery.delivery": "Delivery",
    "delivery.pickup": "Pickup",
    "delivery.none": "No delivery",
    "delivery.readyForPickup": "Ready for pickup",
    "channel.online_store": "Online store",
    "channel.admin": "Dashboard",
    "channel.pos": "POS",
    "channel.agent": "AI agent",
    "channel.app": "App",
    "source.facebook": "Facebook",
    "source.instagram": "Instagram",
    "source.whatsapp": "WhatsApp",
    "source.phone": "Phone",
    "source.walk_in": "Walk-in",
    checkHistoryFor: "Check delivery history for {name}",
  },
  bn: {
    "status.pending": "পেন্ডিং",
    "status.processing": "প্রসেসিং",
    "status.confirmed": "কনফার্মড",
    "status.shipped": "পাঠানো হয়েছে",
    "status.delivered": "ডেলিভারি হয়েছে",
    "status.completed": "সম্পন্ন",
    "status.cancelled": "বাতিল",
    "status.refunded": "রিফান্ড হয়েছে",
    "status.returned": "ফেরত এসেছে",
    "status.incomplete": "অসম্পূর্ণ",
    "payment.unpaid": "পেমেন্ট বাকি",
    "payment.partial": "আংশিক পেমেন্ট",
    "payment.paid": "পেমেন্ট হয়েছে",
    "payment.partially_refunded": "আংশিক ফেরত",
    "payment.refunded": "রিফান্ড হয়েছে",
    "payment.failed": "পেমেন্ট ব্যর্থ",
    "fulfillment.pending": "পাঠানো হয়নি",
    "fulfillment.partial": "আংশিক পাঠানো",
    "fulfillment.complete": "পাঠানো হয়েছে",
    "method.cod": "ক্যাশ অন ডেলিভারি",
    "method.stripe": "কার্ড (Stripe)",
    "method.gift_card": "গিফট কার্ড",
    "request.cancel_pre_shipment": "বাতিলের অনুরোধ",
    "request.return": "ফেরতের অনুরোধ",
    "request.refund": "রিফান্ডের অনুরোধ",
    refundOwed: "রিফান্ড বাকি",
    refundOwedAmount: "রিফান্ড বাকি {amount}",
    archived: "আর্কাইভ করা",
    orders: "অর্ডার",
    order: "অর্ডার {number}",
    "delivery.delivery": "ডেলিভারি",
    "delivery.pickup": "পিকআপ",
    "delivery.none": "ডেলিভারি নেই",
    "delivery.readyForPickup": "পিকআপের জন্য তৈরি",
    "channel.online_store": "অনলাইন স্টোর",
    "channel.admin": "ড্যাশবোর্ড",
    "channel.pos": "POS",
    "channel.agent": "AI এজেন্ট",
    "channel.app": "অ্যাপ",
    "source.facebook": "ফেসবুক",
    "source.instagram": "ইনস্টাগ্রাম",
    "source.whatsapp": "হোয়াটসঅ্যাপ",
    "source.phone": "ফোন",
    "source.walk_in": "দোকানে এসে",
    checkHistoryFor: "{name}-এর ডেলিভারির ইতিহাস দেখুন",
  },
});

export type OrderMessageKey = keyof typeof orderMessages.en;

type Translate = (key: OrderMessageKey, vars?: Record<string, string | number>) => string;

function labelOrRaw(t: Translate, key: string, raw: string): string {
  return key in orderMessages.en ? t(key as OrderMessageKey) : raw.replace(/_/g, " ");
}

/** Label for an order, payment or fulfillment status, or a payment method. */
export const orderStatusLabel = (t: Translate, status: string) =>
  labelOrRaw(t, `status.${status.toLowerCase()}`, status);
export const paymentStatusLabel = (t: Translate, status: string) =>
  labelOrRaw(t, `payment.${status.toLowerCase()}`, status);
export const fulfillmentStatusLabel = (t: Translate, status: string) =>
  labelOrRaw(t, `fulfillment.${status.toLowerCase()}`, status);
/**
 * An app's method (`<plugin id>:<provider id>`) reads as its provider's name
 * from `appNames` (installed apps), else as the provider id in words; never
 * as the stored id.
 */
export const paymentMethodLabel = (t: Translate, method: string, appNames?: ReadonlyMap<string, string>) =>
  appPaymentMethodName(method, appNames) ?? labelOrRaw(t, `method.${method.toLowerCase()}`, method);
/** "Delivery", "Pickup", or "No delivery" (nothing physical: a service). */
export const deliveryMethodLabel = (t: Translate, method: "delivery" | "pickup" | "none") =>
  t(`delivery.${method}`);
/** Where the order came from: "Online store", "Dashboard", "AI agent"… */
export const orderChannelLabel = (t: Translate, channel: OrderChannel) => t(`channel.${channel}`);
/** A preset source in the dashboard language; the merchant's own source as it was saved. */
export const orderChannelSourceLabel = (t: Translate, source: string) =>
  isOrderChannelSourcePreset(source) ? t(`source.${source}`) : source;
/** "Dashboard · Facebook", or just the channel when the order has no source. */
export const orderChannelText = (t: Translate, channel: OrderChannel, source: string | null) =>
  source ? `${orderChannelLabel(t, channel)} · ${orderChannelSourceLabel(t, source)}` : orderChannelLabel(t, channel);
