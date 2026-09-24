// Buyer-facing email and code copy, in the store's checkout language.
import type { CustomerRequestType } from "../settings/customer-request-policy.shared";
import type { OrderNotificationType } from "./notification-types";

export type MessageLanguage = "en" | "bn";

/** Facts a subject or message line may name. `order` is the "#1001" label. */
export interface CopyFacts {
  order: string;
  request: string;
  status: string;
  trackingId: string;
}

type Line = (facts: CopyFacts) => string;
type RequestStatus = "submitted" | "under_review" | "approved" | "rejected" | "withdrawn" | "completed";

interface MessageCopy {
  greeting: (name: string) => string;
  subject: Record<OrderNotificationType, Line>;
  message: Record<OrderNotificationType, Line>;
  request: Record<CustomerRequestType | "other", string>;
  requestStatus: Record<RequestStatus | "other", string>;
  orderSummary: string;
  items: string;
  itemUnavailable: string;
  quantity: (quantity: number) => string;
  subtotal: string;
  shipping: string;
  discount: string;
  tax: string;
  taxIncluded: string;
  total: string;
  amountsUnavailable: string;
  payment: string;
  refunded: string;
  partiallyRefunded: string;
  nothingDue: string;
  paid: string;
  partiallyPaid: string;
  /** Cash on delivery: what is left to pay at the door (`due` null when amounts are unavailable). */
  cod: (due: string | null, partiallyPaid: boolean) => string;
  paymentNotCompleted: string;
  deliveryAddress: string;
  deliveryMethod: string;
  viewOrder: string;
  trackOrder: string;
  visitStore: string;
  needHelp: string;
  otp: {
    subject: (code: string, store: string | null) => string;
    intro: Record<"sign_in" | "order_payment_recovery" | "order_lookup", (store: string | null) => string>;
    expires: string;
    ignore: string;
    sms: (code: string, store: string | null) => string;
  };
}

const EN: MessageCopy = {
  greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
  subject: {
    order_created: ({ order }) => `We've received your order ${order}`,
    order_confirmed: ({ order }) => `Order ${order} confirmed`,
    order_processing: ({ order }) => `Order ${order} is being prepared`,
    order_shipped: ({ order }) => `Order ${order} is on its way`,
    order_delivered: ({ order }) => `Order ${order} delivered`,
    order_completed: ({ order }) => `Order ${order} completed`,
    order_cancelled: ({ order }) => `Order ${order} cancelled`,
    order_returned: ({ order }) => `Order ${order} returned`,
    refund_processing: ({ order }) => `Refund in progress for order ${order}`,
    refund_failed: ({ order }) => `We couldn't refund order ${order}`,
    order_refunded: ({ order }) => `Order ${order} refunded`,
    order_partially_refunded: ({ order }) => `Order ${order} partially refunded`,
    payment_balance_paid: ({ order }) => `Payment received for order ${order}`,
    support_request_submitted: ({ order, request }) => `We received your ${request} for order ${order}`,
    support_request_status_updated: ({ order, request }) => `Update on your ${request} for order ${order}`,
  },
  message: {
    order_created: () => "Thank you for your order. We've received it and will let you know as it progresses.",
    order_confirmed: () => "Your order is confirmed and we're getting it ready.",
    order_processing: () => "We're preparing your order and will let you know when it ships.",
    order_shipped: ({ trackingId }) => `Your order is on its way.${trackingId ? ` Tracking ID: ${trackingId}` : ""}`,
    order_delivered: () => "Your order has been delivered. Thank you for shopping with us.",
    order_completed: () => "Your order is complete. Thank you for shopping with us.",
    order_cancelled: () => "Your order has been cancelled.",
    order_returned: () => "We've received the return for your order.",
    refund_processing: () => "We're processing the refund for this order and will let you know when it's done.",
    refund_failed: () => "We couldn't complete the refund for this order. Please contact us for help.",
    order_refunded: () => "The refund for this order has been processed.",
    order_partially_refunded: () => "A partial refund for this order has been processed.",
    payment_balance_paid: () => "We've received the remaining payment for this order.",
    support_request_submitted: () => "The store will review it and let you know.",
    support_request_status_updated: ({ request, status }) => `Your ${request} is ${status}.`,
  },
  request: {
    cancel_pre_shipment: "cancellation request",
    return: "return request",
    refund: "refund request",
    other: "request",
  },
  requestStatus: {
    submitted: "submitted",
    under_review: "under review",
    approved: "approved",
    rejected: "declined",
    withdrawn: "withdrawn",
    completed: "complete",
    other: "updated",
  },
  orderSummary: "Order summary",
  items: "Items",
  itemUnavailable: "Item name unavailable",
  quantity: (quantity) => `Quantity: ${quantity}`,
  subtotal: "Subtotal",
  shipping: "Delivery",
  discount: "Discount",
  tax: "Tax",
  taxIncluded: "included",
  total: "Total",
  amountsUnavailable: "Order amounts are unavailable in this email.",
  payment: "Payment",
  refunded: "Refunded. No payment is due.",
  partiallyRefunded: "Partially refunded. No payment is due.",
  nothingDue: "No payment is due for this order.",
  paid: "Paid",
  partiallyPaid: "Partially paid",
  cod: (due, partiallyPaid) =>
    `${partiallyPaid ? "Partially paid." : "Cash on delivery."} ${due ? `${due} due on delivery.` : "Payment is due on delivery."}`,
  paymentNotCompleted: "Payment not completed",
  deliveryAddress: "Delivery address",
  deliveryMethod: "Delivery method",
  viewOrder: "View your order",
  trackOrder: "Track your order",
  visitStore: "Visit store",
  needHelp: "Need help?",
  otp: {
    subject: (code, store) => (store ? `${code} is your ${store} code` : `${code} is your verification code`),
    intro: {
      sign_in: (store) => `Use this code to sign in or create your account${store ? ` at ${store}` : ""}.`,
      order_payment_recovery: (store) => `Use this code to finish paying for your order${store ? ` at ${store}` : ""}.`,
      order_lookup: (store) => `Use this code to view your order${store ? ` at ${store}` : ""}.`,
    },
    expires: "This code expires in 5 minutes.",
    ignore: "If you didn't ask for this code, you can ignore this email.",
    sms: (code, store) => `${code} is your ${store ? `${store} ` : "verification "}code. It expires in 5 minutes. Don't share it.`,
  },
};

const BN: MessageCopy = {
  greeting: (name) => (name ? `হ্যালো ${name},` : "হ্যালো,"),
  subject: {
    order_created: ({ order }) => `আপনার অর্ডার ${order} আমরা পেয়েছি`,
    order_confirmed: ({ order }) => `অর্ডার ${order} কনফার্ম হয়েছে`,
    order_processing: ({ order }) => `অর্ডার ${order} প্রস্তুত হচ্ছে`,
    order_shipped: ({ order }) => `অর্ডার ${order} পাঠানো হয়েছে`,
    order_delivered: ({ order }) => `অর্ডার ${order} ডেলিভারি হয়েছে`,
    order_completed: ({ order }) => `অর্ডার ${order} সম্পন্ন হয়েছে`,
    order_cancelled: ({ order }) => `অর্ডার ${order} বাতিল হয়েছে`,
    order_returned: ({ order }) => `অর্ডার ${order} রিটার্ন হয়েছে`,
    refund_processing: ({ order }) => `অর্ডার ${order}-এর রিফান্ড প্রক্রিয়াধীন`,
    refund_failed: ({ order }) => `অর্ডার ${order}-এর রিফান্ড সম্পন্ন হয়নি`,
    order_refunded: ({ order }) => `অর্ডার ${order}-এর রিফান্ড দেওয়া হয়েছে`,
    order_partially_refunded: ({ order }) => `অর্ডার ${order}-এর আংশিক রিফান্ড দেওয়া হয়েছে`,
    payment_balance_paid: ({ order }) => `অর্ডার ${order}-এর পেমেন্ট পেয়েছি`,
    support_request_submitted: ({ order, request }) => `অর্ডার ${order}-এর ${request} আমরা পেয়েছি`,
    support_request_status_updated: ({ order, request }) => `অর্ডার ${order}-এর ${request} নিয়ে আপডেট`,
  },
  message: {
    order_created: () => "অর্ডারের জন্য ধন্যবাদ। আপনার অর্ডার আমরা পেয়েছি, আপডেট হলেই জানিয়ে দেব।",
    order_confirmed: () => "আপনার অর্ডার কনফার্ম হয়েছে, আমরা এটি প্রস্তুত করছি।",
    order_processing: () => "আপনার অর্ডার প্রস্তুত করা হচ্ছে। পাঠানোর সময় জানিয়ে দেব।",
    order_shipped: ({ trackingId }) => `আপনার অর্ডার পাঠানো হয়েছে।${trackingId ? ` ট্র্যাকিং আইডি: ${trackingId}` : ""}`,
    order_delivered: () => "আপনার অর্ডার ডেলিভারি হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।",
    order_completed: () => "আপনার অর্ডার সম্পন্ন হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।",
    order_cancelled: () => "আপনার অর্ডার বাতিল করা হয়েছে।",
    order_returned: () => "আপনার অর্ডারের রিটার্ন আমরা পেয়েছি।",
    refund_processing: () => "এই অর্ডারের রিফান্ড প্রক্রিয়াধীন। শেষ হলেই জানিয়ে দেব।",
    refund_failed: () => "এই অর্ডারের রিফান্ড সম্পন্ন করা যায়নি। সাহায্যের জন্য আমাদের সাথে যোগাযোগ করুন।",
    order_refunded: () => "এই অর্ডারের রিফান্ড দেওয়া হয়েছে।",
    order_partially_refunded: () => "এই অর্ডারের আংশিক রিফান্ড দেওয়া হয়েছে।",
    payment_balance_paid: () => "এই অর্ডারের বাকি টাকা আমরা পেয়েছি।",
    support_request_submitted: () => "স্টোর এটি দেখে আপনাকে জানাবে।",
    support_request_status_updated: ({ request, status }) => `আপনার ${request} ${status}।`,
  },
  request: {
    cancel_pre_shipment: "বাতিলের অনুরোধ",
    return: "রিটার্নের অনুরোধ",
    refund: "রিফান্ডের অনুরোধ",
    other: "অনুরোধ",
  },
  requestStatus: {
    submitted: "জমা হয়েছে",
    under_review: "পর্যালোচনায় আছে",
    approved: "অনুমোদিত হয়েছে",
    rejected: "গ্রহণ করা হয়নি",
    withdrawn: "প্রত্যাহার করা হয়েছে",
    completed: "সম্পন্ন হয়েছে",
    other: "আপডেট হয়েছে",
  },
  orderSummary: "অর্ডারের বিবরণ",
  items: "পণ্য",
  itemUnavailable: "পণ্যের নাম পাওয়া যায়নি",
  quantity: (quantity) => `পরিমাণ: ${quantity}`,
  subtotal: "সাবটোটাল",
  shipping: "ডেলিভারি চার্জ",
  discount: "ছাড়",
  tax: "ট্যাক্স",
  taxIncluded: "দামের মধ্যে ধরা",
  total: "মোট",
  amountsUnavailable: "এই ইমেইলে অর্ডারের টাকার হিসাব দেখানো যাচ্ছে না।",
  payment: "পেমেন্ট",
  refunded: "রিফান্ড দেওয়া হয়েছে। কোনো টাকা বাকি নেই।",
  partiallyRefunded: "আংশিক রিফান্ড দেওয়া হয়েছে। কোনো টাকা বাকি নেই।",
  nothingDue: "এই অর্ডারের জন্য কোনো টাকা দিতে হবে না।",
  paid: "পরিশোধিত",
  partiallyPaid: "আংশিক পরিশোধিত",
  cod: (due, partiallyPaid) =>
    `${partiallyPaid ? "আংশিক পরিশোধিত।" : "ক্যাশ অন ডেলিভারি।"} ${due ? `ডেলিভারির সময় ${due} দিতে হবে।` : "ডেলিভারির সময় টাকা দিতে হবে।"}`,
  paymentNotCompleted: "পেমেন্ট সম্পন্ন হয়নি",
  deliveryAddress: "ডেলিভারি ঠিকানা",
  deliveryMethod: "ডেলিভারি পদ্ধতি",
  viewOrder: "আপনার অর্ডার দেখুন",
  trackOrder: "অর্ডার ট্র্যাক করুন",
  visitStore: "স্টোরে যান",
  needHelp: "কোনো সাহায্য লাগবে?",
  otp: {
    subject: (code, store) => (store ? `${store}-এর কোড ${code}` : `আপনার যাচাই কোড ${code}`),
    intro: {
      sign_in: (store) => `${store ? `${store}-এ ` : ""}সাইন ইন করতে বা অ্যাকাউন্ট খুলতে এই কোডটি ব্যবহার করুন।`,
      order_payment_recovery: (store) => `${store ? `${store}-এ ` : ""}আপনার অর্ডারের পেমেন্ট শেষ করতে এই কোডটি ব্যবহার করুন।`,
      order_lookup: (store) => `${store ? `${store}-এ ` : ""}আপনার অর্ডার দেখতে এই কোডটি ব্যবহার করুন।`,
    },
    expires: "কোডটির মেয়াদ ৫ মিনিট।",
    ignore: "আপনি এই কোড না চাইলে ইমেইলটি উপেক্ষা করুন।",
    sms: (code, store) => `${store ? `${store}-এর` : "আপনার যাচাই"} কোড ${code}। মেয়াদ ৫ মিনিট।`,
  },
};

export const MESSAGE_COPY: Record<MessageLanguage, MessageCopy> = { en: EN, bn: BN };

function pick(table: Record<string, string> & { other: string }, key: unknown): string {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key]! : table.other;
}

/** The support request's type and status words, from the enqueued request facts. */
export function requestCopy(copy: MessageCopy, type: unknown, status: unknown) {
  return { request: pick(copy.request, type), status: pick(copy.requestStatus, status) };
}
