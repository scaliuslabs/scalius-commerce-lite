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
    "method.sslcommerz": "SSLCommerz",
    "request.cancel_pre_shipment": "Cancellation requested",
    "request.return": "Return requested",
    "request.refund": "Refund requested",
    refundOwed: "Refund owed",
    refundOwedAmount: "Refund owed {amount}",
    archived: "Archived",
    orders: "Orders",
    order: "Order {number}",
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
    "method.sslcommerz": "SSLCommerz",
    "request.cancel_pre_shipment": "বাতিলের অনুরোধ",
    "request.return": "ফেরতের অনুরোধ",
    "request.refund": "রিফান্ডের অনুরোধ",
    refundOwed: "রিফান্ড বাকি",
    refundOwedAmount: "রিফান্ড বাকি {amount}",
    archived: "আর্কাইভ করা",
    orders: "অর্ডার",
    order: "অর্ডার {number}",
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
export const paymentMethodLabel = (t: Translate, method: string) =>
  labelOrRaw(t, `method.${method.toLowerCase()}`, method);
