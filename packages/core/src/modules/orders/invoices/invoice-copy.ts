// The printed invoice's words (`renderPrintableInvoice`) in English and
// Bangla: a buyer's copy prints in the order's language, a staff copy in the
// staff member's. The dashboard's invoice sheet speaks the same words from its
// own catalogue (apps/admin-v2 i18n/order-invoice.ts).
export type InvoiceLanguage = "en" | "bn";

export interface InvoiceCopy {
  invoice: (number: string) => string;
  draftInvoice: (order: string) => string;
  draftBanner: string;
  draftBannerDetail: string;
  draft: string;
  order: (number: string) => string;
  billTo: string;
  shipTo: string;
  pickup: string;
  delivery: string;
  noDelivery: string;
  payment: string;
  cashOnDelivery: string;
  paymentStatus: Readonly<Record<string, string>>;
  taxExempt: string;
  terms: (days: string) => string;
  due: (date: string) => string;
  item: string;
  qty: string;
  unitPrice: string;
  amount: string;
  returned: (count: string) => string;
  subtotal: string;
  shipping: string;
  deliveryMethod: (name: string) => string;
  feeWaived: (amount: string) => string;
  discount: string;
  tax: string;
  total: string;
  refunded: string;
  refundedSinceIssue: string;
  totalAfterRefunds: string;
  noSignature: string;
}

const EN: InvoiceCopy = {
  invoice: (number) => `Invoice ${number}`,
  draftInvoice: (order) => `Draft invoice ${order}`,
  draftBanner: "Draft invoice",
  draftBannerDetail: "no invoice number has been allocated.",
  draft: "Draft",
  order: (number) => `Order ${number}`,
  billTo: "Bill to",
  shipTo: "Ship to",
  pickup: "Pickup",
  delivery: "Delivery",
  noDelivery: "No delivery needed",
  payment: "Payment",
  cashOnDelivery: "Cash on delivery",
  paymentStatus: { paid: "paid", unpaid: "unpaid", partial: "partly paid", refunded: "refunded", partially_refunded: "partly refunded", failed: "failed" },
  taxExempt: "Tax exempt",
  terms: (days) => `Terms: Net ${days}`,
  due: (date) => `due ${date}`,
  item: "Item",
  qty: "Qty",
  unitPrice: "Unit price",
  amount: "Amount",
  returned: (count) => `${count} returned`,
  subtotal: "Subtotal",
  shipping: "Shipping",
  deliveryMethod: (name) => `Delivery — ${name}`,
  feeWaived: (amount) => `${amount} fee waived`,
  discount: "Discount",
  tax: "Tax",
  total: "Total",
  refunded: "Refunded",
  refundedSinceIssue: "Refunded since issue",
  totalAfterRefunds: "Total after refunds",
  noSignature: "This is a computer-generated invoice and does not require a signature.",
};

const BN: InvoiceCopy = {
  invoice: (number) => `ইনভয়েস ${number}`,
  draftInvoice: (order) => `খসড়া ইনভয়েস ${order}`,
  draftBanner: "খসড়া ইনভয়েস",
  draftBannerDetail: "এখনও কোনো ইনভয়েস নম্বর দেওয়া হয়নি।",
  draft: "খসড়া",
  order: (number) => `অর্ডার ${number}`,
  billTo: "বিল প্রাপক",
  shipTo: "যেখানে পাঠানো হবে",
  pickup: "পিকআপ",
  delivery: "ডেলিভারি",
  noDelivery: "ডেলিভারির দরকার নেই",
  payment: "পেমেন্ট",
  cashOnDelivery: "ক্যাশ অন ডেলিভারি",
  paymentStatus: { paid: "পরিশোধিত", unpaid: "অপরিশোধিত", partial: "আংশিক পরিশোধিত", refunded: "ফেরত দেওয়া হয়েছে", partially_refunded: "আংশিক ফেরত", failed: "ব্যর্থ" },
  taxExempt: "করমুক্ত",
  terms: (days) => `শর্ত: ${days} দিনে পরিশোধ`,
  due: (date) => `শেষ তারিখ ${date}`,
  item: "প্রোডাক্ট",
  qty: "পরিমাণ",
  unitPrice: "একক দাম",
  amount: "মোট",
  returned: (count) => `${count}টি ফেরত`,
  subtotal: "সাবটোটাল",
  shipping: "শিপিং",
  deliveryMethod: (name) => `ডেলিভারি — ${name}`,
  feeWaived: (amount) => `${amount} চার্জ মওকুফ`,
  discount: "ডিসকাউন্ট",
  tax: "ট্যাক্স",
  total: "মোট",
  refunded: "ফেরত দেওয়া হয়েছে",
  refundedSinceIssue: "ইস্যুর পর ফেরত",
  totalAfterRefunds: "ফেরতের পর মোট",
  noSignature: "এটি কম্পিউটারে তৈরি ইনভয়েস, স্বাক্ষরের প্রয়োজন নেই।",
};

export const INVOICE_COPY: Readonly<Record<InvoiceLanguage, InvoiceCopy>> = { en: EN, bn: BN };

export function isInvoiceLanguage(value: unknown): value is InvoiceLanguage {
  return value === "en" || value === "bn";
}
