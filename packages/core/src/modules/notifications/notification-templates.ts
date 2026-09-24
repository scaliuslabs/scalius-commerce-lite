// Customer notification templates: the default copy (English and Bangla), the
// variables each event can use, and the one email renderer the real send, the
// staff email, the dashboard preview and test sends all run. Pure (no
// database), so the dashboard bundle can import it.

import { escapeHtml } from "@scalius/shared/html-escape";
import { MESSAGE_COPY, type MessageLanguage } from "./message-copy";
import { ORDER_NOTIFICATION_TYPES, type OrderNotificationType } from "./notification-types";

export const TEMPLATE_LIMITS = { subject: 200, emailBody: 10_000, smsBody: 1_000 } as const;

export const NOTIFICATION_VARIABLES = [
  "customer_name",
  "order_number",
  "order_total",
  "cod_amount",
  "store_name",
  "tracking_id",
  "support_request",
  "support_status",
] as const;

export type NotificationVariable = (typeof NOTIFICATION_VARIABLES)[number];
export type NotificationVariableValues = Partial<Record<NotificationVariable, string>>;

const ORDER_VARIABLES: readonly NotificationVariable[] = [
  "customer_name",
  "order_number",
  "order_total",
  "cod_amount",
  "store_name",
];

/** Only what the sender knows for this event. */
export function variablesForEvent(event: OrderNotificationType): readonly NotificationVariable[] {
  if (event === "order_shipped") return [...ORDER_VARIABLES, "tracking_id"];
  if (event === "support_request_submitted") return [...ORDER_VARIABLES, "support_request"];
  if (event === "support_request_status_updated") {
    return [...ORDER_VARIABLES, "support_request", "support_status"];
  }
  return ORDER_VARIABLES;
}

export interface EmailTemplate {
  subject: string;
  body: string;
}

export interface SmsTemplate {
  body: string;
}

export interface NotificationTemplates {
  email: Record<OrderNotificationType, EmailTemplate>;
  sms: Record<OrderNotificationType, SmsTemplate>;
}

/** What a merchant changed; a missing event means the default. */
export interface NotificationTemplateOverrides {
  email: Partial<Record<OrderNotificationType, EmailTemplate>>;
  sms: Partial<Record<OrderNotificationType, SmsTemplate>>;
}

type DefaultCopy = Record<OrderNotificationType, { subject: string; message: string; sms: string }>;

// The default copy per checkout language. A {{tracking_id}} sits on its own
// line, so that line is left out while the tracking ID isn't known yet.
const DEFAULT_COPY: Record<MessageLanguage, { greeting: string; events: DefaultCopy }> = {
  en: {
    greeting: "Hi {{customer_name}},",
    events: {
      order_created: {
        subject: "We've received your order {{order_number}}",
        message: "Thank you for your order. We've received it and will let you know as it progresses.",
        sms: "your order {{order_number}} has been received. We'll process it shortly.",
      },
      order_confirmed: {
        subject: "Order {{order_number}} confirmed",
        message: "Your order is confirmed and we're getting it ready.",
        sms: "your order {{order_number}} has been confirmed and is being prepared.",
      },
      order_processing: {
        subject: "Order {{order_number}} is being prepared",
        message: "We're preparing your order and will let you know when it ships.",
        sms: "your order {{order_number}} is being processed. We'll update you when it ships.",
      },
      order_shipped: {
        subject: "Order {{order_number}} is on its way",
        message: "Your order is on its way.\nTracking ID: {{tracking_id}}",
        sms: "your order {{order_number}} is on its way!\nTracking: {{tracking_id}}",
      },
      order_delivered: {
        subject: "Order {{order_number}} delivered",
        message: "Your order has been delivered. Thank you for shopping with us.",
        sms: "your order {{order_number}} has been delivered. Enjoy!",
      },
      order_completed: {
        subject: "Order {{order_number}} completed",
        message: "Your order is complete. Thank you for shopping with us.",
        sms: "your order {{order_number}} has been completed. Thank you for shopping with us!",
      },
      order_cancelled: {
        subject: "Order {{order_number}} cancelled",
        message: "Your order has been cancelled.",
        sms: "your order {{order_number}} has been cancelled. Contact us if you have questions.",
      },
      order_returned: {
        subject: "Order {{order_number}} returned",
        message: "We've received the return for your order.",
        sms: "your order {{order_number}} has been marked as returned. Contact us if you have questions.",
      },
      refund_processing: {
        subject: "Refund in progress for order {{order_number}}",
        message: "We're processing the refund for this order and will let you know when it's done.",
        sms: "your refund for order {{order_number}} is being processed. We'll update you when it is complete.",
      },
      refund_failed: {
        subject: "We couldn't refund order {{order_number}}",
        message: "We couldn't complete the refund for this order. Please contact us for help.",
        sms: "we couldn't complete the refund for order {{order_number}}. Please contact support for help.",
      },
      order_refunded: {
        subject: "Order {{order_number}} refunded",
        message: "The refund for this order has been processed.",
        sms: "your order {{order_number}} has been refunded. Contact us if you have questions.",
      },
      order_partially_refunded: {
        subject: "Order {{order_number}} partially refunded",
        message: "A partial refund for this order has been processed.",
        sms: "a partial refund has been processed for order {{order_number}}. Contact us if you have questions.",
      },
      payment_balance_paid: {
        subject: "Payment received for order {{order_number}}",
        message: "We've received the remaining payment for this order.",
        sms: "we received the remaining payment for order {{order_number}}. Your order is now fully paid.",
      },
      support_request_submitted: {
        subject: "We received your {{support_request}} for order {{order_number}}",
        message: "The store will review it and let you know.",
        sms: "we received your {{support_request}} for order {{order_number}}. We'll update you soon.",
      },
      support_request_status_updated: {
        subject: "Update on your {{support_request}} for order {{order_number}}",
        message: "Your {{support_request}} is {{support_status}}.",
        sms: "your {{support_request}} for order {{order_number}} is now {{support_status}}.",
      },
    },
  },
  bn: {
    greeting: "হ্যালো {{customer_name}},",
    events: {
      order_created: {
        subject: "আপনার অর্ডার {{order_number}} আমরা পেয়েছি",
        message: "অর্ডারের জন্য ধন্যবাদ। আপনার অর্ডার আমরা পেয়েছি, আপডেট হলেই জানিয়ে দেব।",
        sms: "আপনার অর্ডার {{order_number}} আমরা পেয়েছি। শিগগিরই প্রস্তুত করব।",
      },
      order_confirmed: {
        subject: "অর্ডার {{order_number}} কনফার্ম হয়েছে",
        message: "আপনার অর্ডার কনফার্ম হয়েছে, আমরা এটি প্রস্তুত করছি।",
        sms: "আপনার অর্ডার {{order_number}} কনফার্ম হয়েছে, আমরা এটি প্রস্তুত করছি।",
      },
      order_processing: {
        subject: "অর্ডার {{order_number}} প্রস্তুত হচ্ছে",
        message: "আপনার অর্ডার প্রস্তুত করা হচ্ছে। পাঠানোর সময় জানিয়ে দেব।",
        sms: "আপনার অর্ডার {{order_number}} প্রস্তুত করা হচ্ছে। পাঠানোর সময় জানিয়ে দেব।",
      },
      order_shipped: {
        subject: "অর্ডার {{order_number}} পাঠানো হয়েছে",
        message: "আপনার অর্ডার পাঠানো হয়েছে।\nট্র্যাকিং আইডি: {{tracking_id}}",
        sms: "আপনার অর্ডার {{order_number}} পাঠানো হয়েছে!\nট্র্যাকিং: {{tracking_id}}",
      },
      order_delivered: {
        subject: "অর্ডার {{order_number}} ডেলিভারি হয়েছে",
        message: "আপনার অর্ডার ডেলিভারি হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।",
        sms: "আপনার অর্ডার {{order_number}} ডেলিভারি হয়েছে। ধন্যবাদ!",
      },
      order_completed: {
        subject: "অর্ডার {{order_number}} সম্পন্ন হয়েছে",
        message: "আপনার অর্ডার সম্পন্ন হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।",
        sms: "আপনার অর্ডার {{order_number}} সম্পন্ন হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ!",
      },
      order_cancelled: {
        subject: "অর্ডার {{order_number}} বাতিল হয়েছে",
        message: "আপনার অর্ডার বাতিল করা হয়েছে।",
        sms: "আপনার অর্ডার {{order_number}} বাতিল করা হয়েছে। কোনো প্রশ্ন থাকলে যোগাযোগ করুন।",
      },
      order_returned: {
        subject: "অর্ডার {{order_number}} রিটার্ন হয়েছে",
        message: "আপনার অর্ডারের রিটার্ন আমরা পেয়েছি।",
        sms: "আপনার অর্ডার {{order_number}}-এর রিটার্ন আমরা পেয়েছি। কোনো প্রশ্ন থাকলে যোগাযোগ করুন।",
      },
      refund_processing: {
        subject: "অর্ডার {{order_number}}-এর রিফান্ড প্রক্রিয়াধীন",
        message: "এই অর্ডারের রিফান্ড প্রক্রিয়াধীন। শেষ হলেই জানিয়ে দেব।",
        sms: "অর্ডার {{order_number}}-এর রিফান্ড প্রক্রিয়াধীন। শেষ হলেই জানিয়ে দেব।",
      },
      refund_failed: {
        subject: "অর্ডার {{order_number}}-এর রিফান্ড সম্পন্ন হয়নি",
        message: "এই অর্ডারের রিফান্ড সম্পন্ন করা যায়নি। সাহায্যের জন্য আমাদের সাথে যোগাযোগ করুন।",
        sms: "অর্ডার {{order_number}}-এর রিফান্ড সম্পন্ন করা যায়নি। সাহায্যের জন্য যোগাযোগ করুন।",
      },
      order_refunded: {
        subject: "অর্ডার {{order_number}}-এর রিফান্ড দেওয়া হয়েছে",
        message: "এই অর্ডারের রিফান্ড দেওয়া হয়েছে।",
        sms: "অর্ডার {{order_number}}-এর রিফান্ড দেওয়া হয়েছে। কোনো প্রশ্ন থাকলে যোগাযোগ করুন।",
      },
      order_partially_refunded: {
        subject: "অর্ডার {{order_number}}-এর আংশিক রিফান্ড দেওয়া হয়েছে",
        message: "এই অর্ডারের আংশিক রিফান্ড দেওয়া হয়েছে।",
        sms: "অর্ডার {{order_number}}-এর আংশিক রিফান্ড দেওয়া হয়েছে। কোনো প্রশ্ন থাকলে যোগাযোগ করুন।",
      },
      payment_balance_paid: {
        subject: "অর্ডার {{order_number}}-এর পেমেন্ট পেয়েছি",
        message: "এই অর্ডারের বাকি টাকা আমরা পেয়েছি।",
        sms: "অর্ডার {{order_number}}-এর বাকি টাকা আমরা পেয়েছি। এখন পুরো টাকা পরিশোধ হয়েছে।",
      },
      support_request_submitted: {
        subject: "অর্ডার {{order_number}}-এর {{support_request}} আমরা পেয়েছি",
        message: "স্টোর এটি দেখে আপনাকে জানাবে।",
        sms: "অর্ডার {{order_number}}-এর {{support_request}} আমরা পেয়েছি। শিগগিরই জানাব।",
      },
      support_request_status_updated: {
        subject: "অর্ডার {{order_number}}-এর {{support_request}} নিয়ে আপডেট",
        message: "আপনার {{support_request}} {{support_status}}।",
        sms: "অর্ডার {{order_number}}-এর {{support_request}} {{support_status}}।",
      },
    },
  },
};

/** The copy a store sends until the merchant changes it, in its checkout language. */
export function defaultNotificationTemplates(language: MessageLanguage): NotificationTemplates {
  const { greeting, events } = DEFAULT_COPY[language];
  return {
    email: Object.fromEntries(ORDER_NOTIFICATION_TYPES.map((event) => [event, {
      subject: events[event].subject,
      body: `${greeting}\n\n${events[event].message}`,
    }])) as Record<OrderNotificationType, EmailTemplate>,
    sms: Object.fromEntries(ORDER_NOTIFICATION_TYPES.map((event) => [event, {
      body: `${greeting} ${events[event].sms}`,
    }])) as Record<OrderNotificationType, SmsTemplate>,
  };
}

/** Merchant changes (used as typed) over the defaults of the store's language. */
export function resolveNotificationTemplates(
  overrides: NotificationTemplateOverrides,
  language: MessageLanguage,
): NotificationTemplates {
  const defaults = defaultNotificationTemplates(language);
  return {
    email: { ...defaults.email, ...overrides.email },
    sms: { ...defaults.sms, ...overrides.sms },
  };
}

const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Variables this event can't fill, as the merchant typed them. */
export function findUnknownVariables(template: string, event: OrderNotificationType): string[] {
  const allowed = new Set<string>(variablesForEvent(event));
  const unknown = new Set<string>();
  for (const match of template.matchAll(VARIABLE)) {
    const name = match[1] ?? "";
    if (!allowed.has(name)) unknown.add(name);
  }
  return [...unknown];
}

/**
 * Fills `{{variable}}`s. A line that uses a variable with no value (a tracking
 * ID that isn't known yet) is left out, so no message says "Tracking: ".
 * Values are single-line plain text; HTML escaping happens where HTML is built.
 */
export function renderTemplate(template: string, values: NotificationVariableValues): string {
  const lines: string[] = [];
  for (const line of template.replace(/\r\n?/g, "\n").split("\n")) {
    let missing = false;
    const rendered = line.replace(VARIABLE, (_match, name: string) => {
      const raw = Object.hasOwn(values, name) ? values[name as NotificationVariable] : undefined;
      const value = raw?.replace(/\s+/g, " ").trim();
      if (!value) missing = true;
      return value ?? "";
    });
    if (!missing) lines.push(rendered);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─────────────────────────────────────────
// Order email frame (customer and staff)
// ─────────────────────────────────────────

/** The store as an email shows it. */
export interface EmailStore {
  /** Business `companyName`, else `legalName`; null when neither is set. */
  name: string | null;
  /** The header logo, only when it is an absolute http(s) URL. */
  logoUrl: string | null;
}

export type EmailPayment =
  | { state: "refunded" | "partially_refunded" | "nothing_due" | "paid" | "partially_paid" | "not_completed" }
  | { state: "cod"; due: string | null; partiallyPaid: boolean };

/** One order's facts for an email, money already formatted in its saved currency. */
export interface OrderEmailFacts {
  store: EmailStore;
  /** `unitPrice`/`subtotal` are null when the saved currency can't be shown. */
  items: Array<{ name: string | null; variant: string | null; quantity: number; unitPrice: string | null; subtotal: string | null }>;
  /** Null when the saved currency can't be shown truthfully. */
  amounts: {
    subtotal: string;
    shipping: string;
    discount: string | null;
    tax: { label: string | null; amount: string; included: boolean } | null;
    total: string;
  } | null;
  payment: EmailPayment;
  address: string[];
  method: string[];
  /** Absolute storefront origin, or null when the store address isn't set. */
  origin: string | null;
  /** The buyer's way back to this order: their account, or the public order page for guests. */
  orderLink: { kind: "account" | "track"; href: string } | null;
  support: Array<{ label: string; href: string }>;
}

const SECTION = "margin:24px 0 8px;font-size:18px;line-height:1.3;";
const MUTED = "color:#5f6368;";
const LINK = "color:#174ea6;";
const RULE = "border-bottom:1px solid #dadce0;";
const BUTTON = "display:inline-block;padding:12px 20px;background:#202124;color:#ffffff;text-decoration:none;border-radius:4px;";

/** The branded top of every buyer email: the logo, else the store name. */
export function storeHeaderHtml(store: EmailStore): string {
  if (store.logoUrl) {
    return `<p style="margin:0 0 24px;"><img src="${escapeHtml(store.logoUrl)}" alt="${escapeHtml(store.name ?? "")}" height="48" style="display:block;height:48px;width:auto;max-width:200px;border:0;"></p>`;
  }
  return store.name ? `<p style="margin:0 0 24px;font-size:20px;font-weight:700;">${escapeHtml(store.name)}</p>` : "";
}

function bodyHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function paymentLine(language: MessageLanguage, payment: EmailPayment): string {
  const copy = MESSAGE_COPY[language];
  switch (payment.state) {
    case "cod": return copy.cod(payment.due, payment.partiallyPaid);
    case "refunded": return copy.refunded;
    case "partially_refunded": return copy.partiallyRefunded;
    case "nothing_due": return copy.nothingDue;
    case "paid": return copy.paid;
    case "partially_paid": return copy.partiallyPaid;
    case "not_completed": return copy.paymentNotCompleted;
  }
}

/**
 * The whole order email: the merchant's message, then the order facts in the
 * store's language. `action` replaces the buyer's order link (staff emails
 * link to the dashboard instead).
 */
export function renderOrderEmail(input: {
  language: MessageLanguage;
  facts: OrderEmailFacts;
  /** Rendered subject (plain text). */
  subject: string;
  /** Rendered body (plain text; blank lines separate paragraphs). */
  body: string;
  action?: { label: string; href: string };
}): { subject: string; html: string; text: string } {
  const { language, facts, body, action } = input;
  const copy = MESSAGE_COPY[language];
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
  const { amounts, support } = facts;

  const summary: Array<[string, string]> = [];
  if (amounts) {
    summary.push([copy.subtotal, amounts.subtotal], [copy.shipping, amounts.shipping]);
    if (amounts.discount) summary.push([copy.discount, `−${amounts.discount}`]);
    if (amounts.tax) {
      summary.push([`${amounts.tax.label || copy.tax}${amounts.tax.included ? ` (${copy.taxIncluded})` : ""}`, amounts.tax.amount]);
    }
    summary.push([copy.total, amounts.total]);
  }
  const payment = paymentLine(language, facts.payment);
  const lines = facts.items.map((item) => ({
    name: item.name || copy.itemUnavailable,
    variant: item.variant,
    quantity: item.unitPrice ? `${item.quantity} × ${item.unitPrice}` : copy.quantity(item.quantity),
    subtotal: item.subtotal ?? "",
  }));
  const origin = action ? null : facts.origin;
  const cta = action ?? (origin && facts.orderLink
    ? { label: facts.orderLink.kind === "account" ? copy.viewOrder : copy.trackOrder, href: facts.orderLink.href }
    : null);

  const text = [
    facts.store.name, subject, body,
    cta ? `${cta.label}: ${cta.href}` : "",
    lines.length || summary.length ? copy.orderSummary : "",
    ...lines.map((item) => `${item.name}${item.variant ? ` (${item.variant})` : ""}\n${item.quantity}${item.subtotal ? ` — ${item.subtotal}` : ""}`),
    summary.map(([label, value]) => `${label}: ${value}`).join("\n"),
    amounts ? "" : copy.amountsUnavailable,
    `${copy.payment}: ${payment}`,
    facts.address.length ? `${copy.deliveryAddress}\n${facts.address.join("\n")}` : "",
    facts.method.length ? `${copy.deliveryMethod}\n${facts.method.join("\n")}` : "",
    origin ? `${copy.visitStore}: ${origin}/` : "",
    support.length ? `${copy.needHelp}\n${support.map((contact) => contact.label).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${storeHeaderHtml(facts.store)}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;">${escapeHtml(subject)}</h1>
<div style="margin:0 0 8px;">${bodyHtml(body)}</div>
${cta ? `<p style="margin:0 0 12px;"><a href="${escapeHtml(cta.href)}" style="${BUTTON}">${escapeHtml(cta.label)}</a></p>` : ""}${origin ? `<p style="margin:0 0 24px;"><a href="${escapeHtml(`${origin}/`)}" style="${LINK}">${escapeHtml(copy.visitStore)}</a></p>` : ""}
<h2 style="${SECTION}">${escapeHtml(copy.orderSummary)}</h2>
${lines.length ? `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><thead><tr><th scope="col" style="text-align:left;padding:0 8px 8px 0;${RULE}">${escapeHtml(copy.items)}</th><th scope="col" style="width:34%;text-align:right;padding:0 0 8px;${RULE}">${amounts ? escapeHtml(copy.subtotal) : ""}</th></tr></thead><tbody>${lines.map((item) => `<tr><td style="padding:12px 8px 12px 0;vertical-align:top;${RULE}"><strong>${escapeHtml(item.name)}</strong>${item.variant ? `<div style="${MUTED}">${escapeHtml(item.variant)}</div>` : ""}<div style="font-size:14px;${MUTED}">${escapeHtml(item.quantity)}</div></td><td style="padding:12px 0;vertical-align:top;text-align:right;${RULE}">${escapeHtml(item.subtotal)}</td></tr>`).join("")}</tbody></table>` : ""}
${summary.length ? `<table aria-label="${escapeHtml(copy.orderSummary)}" style="width:100%;border-collapse:collapse;margin:16px 0;">${summary.map(([label, value], index) => {
    const weight = index === summary.length - 1 ? "700" : "400";
    return `<tr><th scope="row" style="padding:4px 12px 4px 0;text-align:left;font-weight:${weight};">${escapeHtml(label)}</th><td style="padding:4px 0;text-align:right;font-weight:${weight};">${escapeHtml(value)}</td></tr>`;
  }).join("")}</table>` : `<p style="${MUTED}">${escapeHtml(copy.amountsUnavailable)}</p>`}
<p style="margin:16px 0 0;"><strong>${escapeHtml(copy.payment)}:</strong> ${escapeHtml(payment)}</p>
${facts.address.length ? `<h2 style="${SECTION}">${escapeHtml(copy.deliveryAddress)}</h2><p style="margin:0;">${facts.address.map((line) => escapeHtml(line)).join("<br>")}</p>` : ""}
${facts.method.length ? `<h2 style="${SECTION}">${escapeHtml(copy.deliveryMethod)}</h2><p style="margin:0;">${escapeHtml(facts.method[0]!)}${facts.method[1] ? `<br><span style="${MUTED}">${escapeHtml(facts.method[1])}</span>` : ""}</p>` : ""}
${support.length ? `<div style="margin-top:24px;border-top:1px solid #dadce0;padding-top:16px;"><p style="margin:0 0 8px;">${escapeHtml(copy.needHelp)}</p>${support.map((contact) => `<p style="margin:4px 0;"><a href="${escapeHtml(contact.href)}" style="${LINK}">${escapeHtml(contact.label)}</a></p>`).join("")}</div>` : ""}
</div></body></html>`;
  return { subject, html, text };
}

// ─────────────────────────────────────────
// Sample order for the dashboard preview and test sends
// ─────────────────────────────────────────

export function sampleVariables(storeName: string, language: MessageLanguage): NotificationVariableValues {
  const copy = MESSAGE_COPY[language];
  return {
    customer_name: "Rahim Uddin",
    order_number: "#1001",
    order_total: "৳1,250",
    cod_amount: "৳1,250",
    store_name: storeName,
    tracking_id: "SF12345678",
    support_request: copy.request.return,
    support_status: copy.requestStatus.approved,
  };
}

/** A sample order in the real email frame, for the dashboard preview and test emails. */
export function sampleOrderEmail(options: {
  language: MessageLanguage;
  store: EmailStore;
  subject: string;
  body: string;
  /** The storefront origin, so the preview shows the guest's order link. */
  origin?: string | null;
}): { subject: string; html: string; text: string } {
  const origin = options.origin?.replace(/\/+$/, "") || null;
  return renderOrderEmail({
    language: options.language,
    subject: options.subject,
    body: options.body,
    facts: {
      store: options.store,
      items: [{ name: "Cotton panjabi", variant: "L", quantity: 1, unitPrice: "৳1,150", subtotal: "৳1,150" }],
      amounts: { subtotal: "৳1,150", shipping: "৳100", discount: null, tax: null, total: "৳1,250" },
      payment: { state: "cod", due: "৳1,250", partiallyPaid: false },
      address: ["Rahim Uddin", "01712-345678", "House 12, Road 5", "Dhanmondi, Dhaka"],
      method: ["Inside Dhaka"],
      origin,
      orderLink: origin ? { kind: "track", href: `${origin}/track-order?order=1001` } : null,
      support: [],
    },
  });
}
