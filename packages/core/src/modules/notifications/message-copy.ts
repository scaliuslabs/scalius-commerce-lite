// The words around buyer and staff messages (order email frame, support
// request names, one-time codes), in the store's checkout language. The
// message text itself is the merchant's template (notification-templates.ts).
import type { CustomerRequestType } from "../settings/customer-request-policy.shared";

export type MessageLanguage = "en" | "bn";

type RequestStatus = "submitted" | "under_review" | "approved" | "rejected" | "withdrawn" | "completed";

interface MessageCopy {
  greeting: (name: string) => string;
  request: Record<CustomerRequestType | "other", string>;
  requestStatus: Record<RequestStatus | "other", string>;
  orderSummary: string;
  items: string;
  itemUnavailable: string;
  quantity: (quantity: number) => string;
  subtotal: string;
  shipping: string;
  /** One discount line: the promotion name and its code, or just "Discount". */
  /** One discount line's word; the name follows via the shared discount name rule. */
  discount: string;
  /** Delivery that cost the buyer nothing. */
  free: string;
  /** The fee a waiver or free-delivery discount replaced, in the text part. */
  was: (amount: string) => string;
  tax: string;
  taxIncluded: string;
  total: string;
  amountsUnavailable: string;
  payment: string;
  refunded: string;
  partiallyRefunded: string;
  /** A refund issued as store credit: the amount and the new gift card's last 4. */
  storeCreditRefund: (amount: string, last4: string | null) => string;
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
  /** The staff "new order" email. */
  staffOrder: {
    subject: (store: string | null, order: string, customer: string) => string;
    body: (customer: string, order: string, total: string) => string;
    action: string;
  };
  /** Staff alerts a domain raises about an order (push title, push/email body). `order` is "#1057". */
  staffAlert: {
    review_pending: { title: string; body: (order: string) => string };
    digital_keys_exhausted: { title: string; body: (order: string) => string };
    emailSubject: (store: string | null, title: string) => string;
    action: string;
  };
  /** Thread notifications: a reply to the buyer, a new buyer message to staff. `order` is "#1057" or null. */
  conversation: {
    replySubject: (store: string | null, order: string | null) => string;
    replyIntro: (store: string | null, order: string | null) => string;
    replyAction: string;
    replyNoReply: string;
    /** No message text in SMS. */
    replySms: (store: string | null, order: string | null) => string;
    staffTitle: (order: string | null) => string;
    staffBody: string;
    staffEmailSubject: (store: string | null, order: string | null, customer: string) => string;
    staffEmailBody: (customer: string, order: string | null) => string;
    staffAction: string;
  };
  otp: {
    subject: (code: string, store: string | null) => string;
    /** `order` is the formatted order number ("#1057") for order codes. */
    intro: Record<"sign_in" | "order_payment_recovery" | "order_lookup", (store: string | null, order: string | null) => string>;
    expires: string;
    ignore: string;
    sms: (code: string, store: string | null) => string;
  };
}

const EN: MessageCopy = {
  greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
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
  free: "Free",
  was: (amount) => `(was ${amount})`,
  tax: "Tax",
  taxIncluded: "included",
  total: "Total",
  amountsUnavailable: "Order amounts are unavailable in this email.",
  payment: "Payment",
  refunded: "Refunded. No payment is due.",
  partiallyRefunded: "Partially refunded. No payment is due.",
  storeCreditRefund: (amount, last4) => `${amount} as store credit on a gift card${last4 ? ` ending ${last4}` : ""}. Use it at checkout.`,
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
  staffOrder: {
    subject: (store, order, customer) => `${store ? `[${store}] ` : ""}Order ${order} placed by ${customer}`,
    body: (customer, order, total) => `${customer} placed order ${order}${total ? ` for ${total}` : ""}.`,
    action: "View order",
  },
  staffAlert: {
    review_pending: {
      title: "New review waiting for approval",
      body: (order) => `A review for order ${order} is waiting for approval.`,
    },
    digital_keys_exhausted: {
      title: "Licence keys ran out",
      body: (order) => `Order ${order} is waiting for licence keys. Import more keys to deliver it.`,
    },
    emailSubject: (store, title) => `${store ? `[${store}] ` : ""}${title}`,
    action: "View order",
  },
  conversation: {
    replySubject: (store, order) => `${store ?? "The store"} replied${order ? ` about order ${order}` : ""}`,
    replyIntro: (store, order) => `${store ?? "The store"} sent you a message${order ? ` about order ${order}` : ""}:`,
    replyAction: "Reply",
    replyNoReply: "Please reply from the store's website, not to this email.",
    replySms: (store, order) => `${store ?? "The store"} replied to your message${order ? ` about order ${order}` : ""}. Check your email or your account to read it.`,
    staffTitle: (order) => (order ? `New message about ${order}` : "New customer message"),
    staffBody: "Open the inbox to read and reply.",
    staffEmailSubject: (store, order, customer) => `${store ? `[${store}] ` : ""}New message from ${customer}${order ? ` about ${order}` : ""}`,
    staffEmailBody: (customer, order) => `${customer} sent a message${order ? ` about order ${order}` : ""}. Open the inbox to read and reply.`,
    staffAction: "Open inbox",
  },
  otp: {
    subject: (code, store) => (store ? `${code} is your ${store} code` : `${code} is your verification code`),
    intro: {
      sign_in: (store) => `Use this code to sign in or create your account${store ? ` at ${store}` : ""}.`,
      order_payment_recovery: (store, order) =>
        `Use this code to finish paying for ${order ? `order ${order}` : "your order"}${store ? ` at ${store}` : ""}.`,
      order_lookup: (store, order) => `Use this code to view ${order ? `order ${order}` : "your order"}${store ? ` at ${store}` : ""}.`,
    },
    expires: "This code expires in 5 minutes.",
    ignore: "If you didn't ask for this code, you can ignore this email.",
    sms: (code, store) => `${code} is your ${store ? `${store} ` : "verification "}code. It expires in 5 minutes. Don't share it.`,
  },
};

const BN: MessageCopy = {
  greeting: (name) => (name ? `হ্যালো ${name},` : "হ্যালো,"),
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
  free: "ফ্রি",
  was: (amount) => `(আগে ছিল ${amount})`,
  tax: "ট্যাক্স",
  taxIncluded: "দামের মধ্যে ধরা",
  total: "মোট",
  amountsUnavailable: "এই ইমেইলে অর্ডারের টাকার হিসাব দেখানো যাচ্ছে না।",
  payment: "পেমেন্ট",
  refunded: "রিফান্ড দেওয়া হয়েছে। কোনো টাকা বাকি নেই।",
  partiallyRefunded: "আংশিক রিফান্ড দেওয়া হয়েছে। কোনো টাকা বাকি নেই।",
  storeCreditRefund: (amount, last4) => `${amount} স্টোর ক্রেডিট হিসেবে একটি গিফট কার্ডে${last4 ? ` (শেষ চার অক্ষর ${last4})` : ""} দেওয়া হয়েছে। চেকআউটে ব্যবহার করুন।`,
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
  staffOrder: {
    subject: (store, order, customer) => `${store ? `[${store}] ` : ""}${customer} অর্ডার ${order} করেছেন`,
    body: (customer, order, total) => `${customer} অর্ডার ${order} করেছেন${total ? `, মোট ${total}` : ""}।`,
    action: "অর্ডার দেখুন",
  },
  staffAlert: {
    review_pending: {
      title: "নতুন রিভিউ অনুমোদনের অপেক্ষায়",
      body: (order) => `অর্ডার ${order}-এর একটি রিভিউ অনুমোদনের অপেক্ষায় আছে।`,
    },
    digital_keys_exhausted: {
      title: "লাইসেন্স কী শেষ হয়ে গেছে",
      body: (order) => `অর্ডার ${order} লাইসেন্স কী-এর অপেক্ষায় আছে। ডেলিভারি দিতে আরও কী যোগ করুন।`,
    },
    emailSubject: (store, title) => `${store ? `[${store}] ` : ""}${title}`,
    action: "অর্ডার দেখুন",
  },
  conversation: {
    replySubject: (store, order) => `${store ?? "স্টোর"} উত্তর দিয়েছে${order ? ` (অর্ডার ${order})` : ""}`,
    replyIntro: (store, order) => `${store ?? "স্টোর"} আপনাকে একটি মেসেজ পাঠিয়েছে${order ? ` (অর্ডার ${order})` : ""}:`,
    replyAction: "উত্তর দিন",
    replyNoReply: "এই ইমেইলে উত্তর দেবেন না, স্টোরের ওয়েবসাইট থেকে উত্তর দিন।",
    replySms: (store, order) => `${store ?? "স্টোর"} আপনার মেসেজের উত্তর দিয়েছে${order ? ` (অর্ডার ${order})` : ""}। পড়তে ইমেইল বা অ্যাকাউন্ট দেখুন।`,
    staffTitle: (order) => (order ? `${order} নিয়ে নতুন মেসেজ` : "ক্রেতার নতুন মেসেজ"),
    staffBody: "পড়তে ও উত্তর দিতে ইনবক্স খুলুন।",
    staffEmailSubject: (store, order, customer) => `${store ? `[${store}] ` : ""}${customer}-এর নতুন মেসেজ${order ? ` (${order})` : ""}`,
    staffEmailBody: (customer, order) => `${customer} একটি মেসেজ পাঠিয়েছেন${order ? ` (অর্ডার ${order})` : ""}। পড়তে ও উত্তর দিতে ইনবক্স খুলুন।`,
    staffAction: "ইনবক্স খুলুন",
  },
  otp: {
    subject: (code, store) => (store ? `${store}-এর কোড ${code}` : `আপনার যাচাই কোড ${code}`),
    intro: {
      sign_in: (store) => `${store ? `${store}-এ ` : ""}সাইন ইন করতে বা অ্যাকাউন্ট খুলতে এই কোডটি ব্যবহার করুন।`,
      order_payment_recovery: (store, order) =>
        `${store ? `${store}-এ ` : ""}${order ? `অর্ডার ${order}-এর` : "আপনার অর্ডারের"} পেমেন্ট শেষ করতে এই কোডটি ব্যবহার করুন।`,
      order_lookup: (store, order) =>
        `${store ? `${store}-এ ` : ""}${order ? `অর্ডার ${order}` : "আপনার অর্ডার"} দেখতে এই কোডটি ব্যবহার করুন।`,
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
