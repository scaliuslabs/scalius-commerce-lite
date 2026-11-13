import { isOrderChannelSourcePreset, type OrderChannel } from "@scalius/shared/order-channel";
import { appPaymentMethodName } from "~/lib/app-payment-method";
import { cashCollectionPoint, isBuiltInOrderPaymentMethod, type BuiltInOrderPaymentMethod, type CashCollectionPoint } from "@scalius/shared/order-payment-methods";
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
    "payment.dueOnDelivery": "Due on delivery",
    "payment.dueAtPickup": "Due at pickup",
    "payment.dueOnService": "Due on service",
    "payment.lostToDispute": "Lost to dispute",
    "payment.partlyLostToDispute": "Partly lost to dispute",
    "payment.partial": "Partially paid",
    "payment.paid": "Paid",
    "payment.partially_refunded": "Partially refunded",
    "payment.refunded": "Refunded",
    "payment.failed": "Payment failed",
    "fulfillment.pending": "Unfulfilled",
    "fulfillment.partial": "Partially fulfilled",
    "fulfillment.complete": "Fulfilled",
    "method.cod": "Cash on delivery",
    "method.payAtPickup": "Pay at pickup",
    "method.payOnService": "Pay on service",
    // A deposit plan's rest, paid in cash where the order is handed over.
    "cashBalance.delivery": "Cash balance on delivery",
    "cashBalance.pickup": "Cash balance at pickup",
    "cashBalance.service": "Cash balance on service",
    "method.net_terms": "Invoice",
    "method.stripe": "Card (Stripe)",
    "method.gift_card": "Gift card",
    // Paid as it was placed (marked paid, a point-of-sale sale): cash, a transfer or a card terminal.
    "method.manual": "Recorded payment",
    "request.cancel_pre_shipment": "Cancellation requested",
    "request.return": "Return requested",
    "request.refund": "Refund requested",
    refundOwed: "Refund owed",
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
    // A customer's personal data was erased: the order keeps its money, lines and region.
    erasedCustomer: "Erased customer",
    erasedValue: "Erased",
  },
  bn: {
    "status.pending": "অপেক্ষমাণ",
    "status.processing": "প্রক্রিয়াধীন",
    "status.confirmed": "নিশ্চিত",
    "status.shipped": "পাঠানো হয়েছে",
    "status.delivered": "ডেলিভারি হয়েছে",
    "status.completed": "সম্পন্ন",
    "status.cancelled": "বাতিল",
    "status.refunded": "টাকা ফেরত হয়েছে",
    "status.returned": "ফেরত এসেছে",
    "status.incomplete": "অসম্পূর্ণ",
    "payment.unpaid": "অপরিশোধিত",
    "payment.dueOnDelivery": "ডেলিভারির সময় পরিশোধযোগ্য",
    "payment.dueAtPickup": "সংগ্রহের সময় পরিশোধযোগ্য",
    "payment.dueOnService": "সেবার সময় পরিশোধযোগ্য",
    "payment.lostToDispute": "বিরোধে হারানো",
    "payment.partlyLostToDispute": "আংশিক বিরোধে হারানো",
    "payment.partial": "আংশিক পরিশোধিত",
    "payment.paid": "পরিশোধিত",
    "payment.partially_refunded": "আংশিক টাকা ফেরত হয়েছে",
    "payment.refunded": "টাকা ফেরত হয়েছে",
    "payment.failed": "পেমেন্ট ব্যর্থ",
    "fulfillment.pending": "পাঠানো হয়নি",
    "fulfillment.partial": "আংশিক পাঠানো",
    "fulfillment.complete": "পাঠানো হয়েছে",
    "method.cod": "ক্যাশ অন ডেলিভারি",
    "method.payAtPickup": "সংগ্রহের সময় পরিশোধ",
    "method.payOnService": "সেবার সময় পরিশোধ",
    "cashBalance.delivery": "ডেলিভারিতে বাকি টাকা",
    "cashBalance.pickup": "সংগ্রহের সময় বাকি টাকা",
    "cashBalance.service": "সেবার সময় বাকি টাকা",
    "method.net_terms": "ইনভয়েস",
    "method.stripe": "কার্ড (Stripe)",
    "method.gift_card": "গিফট কার্ড",
    "method.manual": "রেকর্ড করা পেমেন্ট",
    "request.cancel_pre_shipment": "বাতিলের অনুরোধ",
    "request.return": "ফেরতের অনুরোধ",
    "request.refund": "রিফান্ডের অনুরোধ",
    refundOwed: "রিফান্ড বাকি",
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
    // A customer's personal data was erased: the order keeps its money, lines and region.
    erasedCustomer: "মুছে ফেলা কাস্টমার",
    erasedValue: "মুছে ফেলা হয়েছে",
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
/**
 * Where an order's cash is paid: the order's delivery facts (`cashCollectionPoint`),
 * a point already read (a saved document's), or null for the method in general.
 */
export type CashPlace = { shippingMethodKind?: string | null; requiresShipping?: boolean | null } | CashCollectionPoint | null;
const cashPoint = (place: CashPlace): CashCollectionPoint =>
  typeof place === "string" ? place : cashCollectionPoint(place ?? {});
const CASH_METHOD_KEYS: Record<CashCollectionPoint, OrderMessageKey> = {
  delivery: "method.cod",
  pickup: "method.payAtPickup",
  service: "method.payOnService",
};
const CASH_DUE_KEYS: Record<CashCollectionPoint, OrderMessageKey> = {
  delivery: "payment.dueOnDelivery",
  pickup: "payment.dueAtPickup",
  service: "payment.dueOnService",
};
/** A deposit plan's cash rest, named for where it is paid: "Cash balance on delivery", "… at pickup", "… on service". */
export const cashBalanceLabel = (t: Translate, place: CashPlace) => t(`cashBalance.${cashPoint(place)}`);
/** "Due on delivery", "Due at pickup" or "Due on service": an unpaid cash order is not late, it is due where it is handed over. */
export const cashDueKey = (place: CashPlace): OrderMessageKey => CASH_DUE_KEYS[cashPoint(place)];
/** An order as its payment words read it: its method and where it is handed over. */
export type PaymentWordsOrder = { paymentMethod?: string | null; shippingMethodKind?: string | null; requiresShipping?: boolean | null };
/**
 * A payment status in words. Given the order's method and where it is handed
 * over, an unpaid cash order is not late, it is "Due on delivery" (or "Due at
 * pickup", "Due on service": the words the storefront's confirmation uses).
 * Without them (a filter), the status in general.
 */
export const paymentStatusLabel = (t: Translate, status: string, cash?: { method: string | null | undefined; place: CashPlace }) =>
  cash?.method === "cod" && status.toLowerCase() === "unpaid"
    ? t(cashDueKey(cash.place))
    : labelOrRaw(t, `payment.${status.toLowerCase()}`, status);
export const fulfillmentStatusLabel = (t: Translate, status: string) =>
  labelOrRaw(t, `fulfillment.${status.toLowerCase()}`, status);
/**
 * An app's method (`<plugin id>:<provider id>`) reads as its provider's name
 * from `appNames` (installed apps), else as the provider id in words; never
 * as the stored id.
 */
export const paymentMethodLabel = (t: Translate, method: string, place: CashPlace, appNames?: ReadonlyMap<string, string>) =>
  method === "cod"
    ? t(CASH_METHOD_KEYS[cashPoint(place)])
    : isBuiltInOrderPaymentMethod(method)
    ? t(PAYMENT_METHOD_KEYS[method])
    : appPaymentMethodName(method, appNames) ?? labelOrRaw(t, `method.${method.toLowerCase()}`, method);

/** Every method the platform writes has its words (a new one fails to compile until it has). */
export const PAYMENT_METHOD_KEYS: Record<BuiltInOrderPaymentMethod, OrderMessageKey> = {
  cod: "method.cod",
  net_terms: "method.net_terms",
  manual: "method.manual",
  gift_card: "method.gift_card",
  stripe: "method.stripe",
};
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
