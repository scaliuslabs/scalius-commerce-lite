// Customer notification templates: the default copy, the variables each event
// can use, and the one renderer both the real send and the dashboard preview
// run. Pure (no database), so the dashboard bundle can import it.

import { escapeHtml } from "@scalius/shared/html-escape";
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

// [subject ending, email message, SMS message]
const DEFAULT_COPY: Record<OrderNotificationType, [string, string, string]> = {
  order_created: [
    "received",
    "Thank you for your order. We've received it and will update you as it progresses.",
    "your order {{order_number}} has been received. We'll process it shortly.",
  ],
  order_confirmed: [
    "confirmed",
    "Your order has been confirmed and is being prepared.",
    "your order {{order_number}} has been confirmed and is being prepared.",
  ],
  order_processing: [
    "processing",
    "Your order is being processed. We'll update you when it ships.",
    "your order {{order_number}} is being processed. We'll update you when it ships.",
  ],
  order_shipped: [
    "shipped",
    "Your order is on its way.\nTracking ID: {{tracking_id}}",
    "your order {{order_number}} is on its way!\nTracking: {{tracking_id}}",
  ],
  order_delivered: [
    "delivered",
    "Your order has been delivered. Thank you for shopping with us.",
    "your order {{order_number}} has been delivered. Enjoy!",
  ],
  order_completed: [
    "completed",
    "Your order has been completed. Thank you for shopping with us.",
    "your order {{order_number}} has been completed. Thank you for shopping with us!",
  ],
  order_cancelled: [
    "cancelled",
    "Your order has been cancelled.",
    "your order {{order_number}} has been cancelled. Contact us if you have questions.",
  ],
  order_returned: [
    "returned",
    "Your order has been marked as returned.",
    "your order {{order_number}} has been marked as returned. Contact us if you have questions.",
  ],
  refund_processing: [
    "refund processing",
    "Your refund for this order is being processed. We'll update you when it is complete.",
    "your refund for order {{order_number}} is being processed. We'll update you when it is complete.",
  ],
  refund_failed: [
    "refund failed",
    "We couldn't complete the refund for this order. Please contact support for help.",
    "we couldn't complete the refund for order {{order_number}}. Please contact support for help.",
  ],
  order_refunded: [
    "refunded",
    "A refund has been processed for this order.",
    "your order {{order_number}} has been refunded. Contact us if you have questions.",
  ],
  order_partially_refunded: [
    "partially refunded",
    "A partial refund has been processed for this order.",
    "a partial refund has been processed for order {{order_number}}. Contact us if you have questions.",
  ],
  payment_balance_paid: [
    "balance paid",
    "We've received the remaining payment for this order.",
    "we received the remaining payment for order {{order_number}}. Your order is now fully paid.",
  ],
  support_request_submitted: [
    "support request received",
    "We've received your {{support_request}}. The merchant will review it and update you soon.",
    "we received your {{support_request}} for order {{order_number}}. We'll update you soon.",
  ],
  support_request_status_updated: [
    "support request updated",
    "Your {{support_request}} is now {{support_status}}.",
    "your {{support_request}} for order {{order_number}} is now {{support_status}}.",
  ],
};

export const DEFAULT_NOTIFICATION_TEMPLATES: NotificationTemplates = {
  email: Object.fromEntries(ORDER_NOTIFICATION_TYPES.map((event) => {
    const [subject, message] = DEFAULT_COPY[event];
    return [event, {
      subject: `Order {{order_number}} ${subject}`,
      body: `Hi {{customer_name}},\n\n${message}`,
    }];
  })) as Record<OrderNotificationType, EmailTemplate>,
  sms: Object.fromEntries(ORDER_NOTIFICATION_TYPES.map((event) => [
    event,
    { body: `Hi {{customer_name}}, ${DEFAULT_COPY[event][2]}` },
  ])) as Record<OrderNotificationType, SmsTemplate>,
};

/** Merchant changes over the defaults. */
export function resolveNotificationTemplates(
  overrides: NotificationTemplateOverrides,
): NotificationTemplates {
  return {
    email: { ...DEFAULT_NOTIFICATION_TEMPLATES.email, ...overrides.email },
    sms: { ...DEFAULT_NOTIFICATION_TEMPLATES.sms, ...overrides.sms },
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

/** "#1001" once orders carry a number; the short order id until then. */
export function formatOrderNumber(orderNumber: number | null | undefined, orderId: string): string {
  return typeof orderNumber === "number" && Number.isInteger(orderNumber) && orderNumber > 0
    ? `#${orderNumber}`
    : `#${orderId}`;
}

// ─────────────────────────────────────────
// Customer order email layout
// ─────────────────────────────────────────

export interface OrderEmailView {
  storeName: string;
  /** Rendered subject (plain text). */
  subject: string;
  /** Rendered body (plain text; blank lines separate paragraphs). */
  body: string;
  items: Array<{ name: string; variant?: string; quantity: string; subtotal: string }>;
  summary: Array<[label: string, value: string]>;
  amountsUnavailable: boolean;
  payment: string;
  /** Absolute storefront origin, or null when the store address isn't set. */
  origin: string | null;
  support: Array<{ label: string; href: string }>;
  /** Replaces the customer account links (staff emails link to the dashboard). */
  action?: { label: string; href: string };
}

function bodyHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The whole customer email: the merchant's message, then the order facts. */
export function renderOrderEmail(view: OrderEmailView): { subject: string; html: string; text: string } {
  const subject = view.subject.replace(/[\r\n]+/g, " ").trim();
  const { items, summary, payment, support, action } = view;
  const origin = action ? null : view.origin;
  const text = [
    view.storeName,
    subject,
    view.body,
    ...items.map((item) => `${item.name}${item.variant ? ` (${item.variant})` : ""}\n${item.quantity}${item.subtotal ? ` — ${item.subtotal}` : ""}`),
    ...summary.map(([label, value]) => `${label}: ${value}`),
    view.amountsUnavailable ? "Order amounts are unavailable in this email." : "",
    payment ? `Payment: ${payment}` : "",
    origin ? `View your account: ${origin}/account\nVisit store: ${origin}/` : "",
    action ? `${action.label}: ${action.href}` : "",
    support.length ? `Need help?\n${support.map((contact) => contact.label).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${view.storeName ? `<p style="margin:0 0 20px;font-size:18px;font-weight:600;">${escapeHtml(view.storeName)}</p>` : ""}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;">${escapeHtml(subject)}</h1>
<div style="margin:0 0 8px;">${bodyHtml(view.body)}</div>
${items.length ? `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><thead><tr><th scope="col" style="text-align:left;padding:0 8px 8px 0;border-bottom:1px solid #dadce0;">Items</th><th scope="col" style="width:34%;text-align:right;padding:0 0 8px;border-bottom:1px solid #dadce0;">${summary.length ? "Subtotal" : ""}</th></tr></thead><tbody>${items.map((item) => `<tr><td style="padding:12px 8px 12px 0;vertical-align:top;border-bottom:1px solid #dadce0;"><strong>${escapeHtml(item.name)}</strong>${item.variant ? `<div style="color:#5f6368;">${escapeHtml(item.variant)}</div>` : ""}<div style="font-size:14px;color:#5f6368;">${escapeHtml(item.quantity)}</div></td><td style="padding:12px 0;vertical-align:top;text-align:right;border-bottom:1px solid #dadce0;">${escapeHtml(item.subtotal)}</td></tr>`).join("")}</tbody></table>` : ""}
${summary.length ? `<table aria-label="Order amounts" style="width:100%;border-collapse:collapse;margin:16px 0;">${summary.map(([label, value]) => `<tr><th scope="row" style="padding:4px 12px 4px 0;text-align:left;font-weight:${label === "Total" ? "700" : "400"};">${escapeHtml(label)}</th><td style="padding:4px 0;text-align:right;font-weight:${label === "Total" ? "700" : "400"};">${escapeHtml(value)}</td></tr>`).join("")}</table>` : ""}
${view.amountsUnavailable ? '<p style="color:#5f6368;">Order amounts are unavailable in this email.</p>' : ""}
${payment ? `<p style="margin:16px 0 24px;"><strong>Payment:</strong> ${escapeHtml(payment)}</p>` : ""}
${origin ? `<p style="margin:24px 0 12px;"><a href="${escapeHtml(`${origin}/account`)}" style="display:inline-block;padding:12px 20px;background:#202124;color:#ffffff;text-decoration:none;border-radius:4px;">View your account</a></p><p style="margin:0 0 24px;"><a href="${escapeHtml(`${origin}/`)}" style="color:#174ea6;">Visit store</a></p>` : ""}
${action ? `<p style="margin:24px 0;"><a href="${escapeHtml(action.href)}" style="display:inline-block;padding:12px 20px;background:#202124;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(action.label)}</a></p>` : ""}
${support.length ? `<div style="border-top:1px solid #dadce0;padding-top:16px;"><p style="margin:0 0 8px;">Need help?</p>${support.map((contact) => `<p style="margin:4px 0;"><a href="${escapeHtml(contact.href)}" style="color:#174ea6;">${escapeHtml(contact.label)}</a></p>`).join("")}</div>` : ""}
</div></body></html>`;
  return { subject, html, text };
}

// ─────────────────────────────────────────
// Sample data for the dashboard preview and test sends
// ─────────────────────────────────────────

export const SAMPLE_VARIABLES: Required<Omit<NotificationVariableValues, "store_name">> = {
  customer_name: "Rahim Uddin",
  order_number: "#1001",
  order_total: "৳1,250",
  cod_amount: "৳1,250",
  tracking_id: "SF12345678",
  support_request: "return request",
  support_status: "approved",
};

export function sampleVariables(storeName: string): NotificationVariableValues {
  return { ...SAMPLE_VARIABLES, store_name: storeName };
}

/** A sample order around the merchant's message, for previews and test emails. */
export function sampleOrderEmail(options: {
  storeName: string;
  subject: string;
  body: string;
  origin?: string | null;
}): { subject: string; html: string; text: string } {
  return renderOrderEmail({
    storeName: options.storeName,
    subject: options.subject,
    body: options.body,
    items: [{ name: "Cotton panjabi", variant: "Size: L", quantity: "1 × ৳1,150", subtotal: "৳1,150" }],
    summary: [["Subtotal", "৳1,150"], ["Shipping", "৳100"], ["Total", "৳1,250"]],
    amountsUnavailable: false,
    payment: "Cash on delivery. ৳1,250 due on delivery.",
    origin: options.origin ?? null,
    support: [],
  });
}
