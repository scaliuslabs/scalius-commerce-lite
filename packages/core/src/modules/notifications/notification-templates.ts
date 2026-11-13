// Customer notification templates: the default copy (English and Bangla), the
// variables each event can use, and the one email renderer the real send, the
// staff email, the dashboard preview and test sends all run. Pure (no
// database), so the dashboard bundle can import it.

import { trimTrailingCharacter } from "@scalius/shared/text-scan";
import { formatDiscountLineLabel } from "@scalius/shared/checkout-language-format";
import { escapeHtml } from "@scalius/shared/html-escape";
import { resolveTranslatedField, translationChain, type TranslationRow } from "@scalius/shared/translations";
import { formatNumber, numberLocale } from "@scalius/shared/locale-format";
import { formatMoney } from "@scalius/shared/currency";
import type { CashCollectionPoint } from "@scalius/shared/order-payment-methods";
import { MESSAGE_COPY, type MessageLanguage } from "./message-copy";
// The default copy (English and Bangla), which the API Worker ships as a Text module.
import { NOTIFICATION_DEFAULT_COPY } from "#notification-default-copy";
import {
  TEMPLATED_NOTIFICATION_TYPES,
  isResolvedNotificationType,
  type TemplatedNotificationType,
} from "./notification-types";

export const TEMPLATE_LIMITS = { subject: 200, emailBody: 10_000, smsBody: 1_000 } as const;

export const NOTIFICATION_VARIABLES = [
  "customer_name",
  "order_number",
  "order_total",
  "cod_amount",
  "store_name",
  "tracking_id",
  "courier_name",
  "tracking_url",
  "refund_amount",
  "support_request",
  "support_status",
  "pickup_address",
  "pickup_hours",
  "pending_downloads",
  // Resolved at send time by the API layer (Wave B §10); never persisted.
  "download_names",
  "licence_keys",
  "sms_licence_keys",
  "access_link",
  "review_products",
  "review_link",
  "gift_card_code",
  "gift_card_value",
  "gift_card_expires",
  "gift_card_message",
  "gift_card_sender",
  "gift_card_link",
  "gift_card_recipient",
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
export function variablesForEvent(event: TemplatedNotificationType): readonly NotificationVariable[] {
  // `sms_licence_keys` holds the keys only when they fit a short SMS; otherwise
  // it is empty and the line that uses it is left out.
  if (event === "order_digital_delivered") {
    return ["customer_name", "order_number", "store_name", "download_names", "licence_keys", "sms_licence_keys", "access_link"];
  }
  if (event === "review_request") return ["customer_name", "order_number", "store_name", "review_products", "review_link"];
  if (event === "gift_card_issued") {
    return [
      "customer_name",
      "store_name",
      "gift_card_code",
      "gift_card_value",
      "gift_card_expires",
      "gift_card_message",
      "gift_card_sender",
      "gift_card_link",
    ];
  }
  if (event === "gift_card_sent") {
    return ["customer_name", "store_name", "order_number", "gift_card_value", "gift_card_recipient"];
  }
  if (event === "order_shipped") return [...ORDER_VARIABLES, "tracking_id", "courier_name", "tracking_url"];
  if (event === "order_ready_for_pickup") return [...ORDER_VARIABLES, "pickup_address", "pickup_hours"];
  if (event === "order_delivered") return [...ORDER_VARIABLES, "pending_downloads"];
  if (event === "order_refunded" || event === "order_partially_refunded" || event === "refund_processing" || event === "refund_failed") {
    return [...ORDER_VARIABLES, "refund_amount"];
  }
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
  email: Record<TemplatedNotificationType, EmailTemplate>;
  sms: Record<TemplatedNotificationType, SmsTemplate>;
}

/** What a merchant changed; a missing event means the default. */
export interface NotificationTemplateOverrides {
  /** In the store's default language. */
  email: Partial<Record<TemplatedNotificationType, EmailTemplate>>;
  sms: Partial<Record<TemplatedNotificationType, SmsTemplate>>;
  /**
   * The merchant's versions in the store's other languages (a store language
   * locale, `bn`): each field falls back through `translationChain()` to the
   * default-language template above, never to the platform's words while the
   * merchant has their own.
   */
  languages?: Partial<Record<string, TemplateLanguageVersion>>;
}

/** One language's version of the merchant's templates: only the events and fields written in it. */
export interface TemplateLanguageVersion {
  email: Partial<Record<TemplatedNotificationType, Partial<EmailTemplate>>>;
  sms: Partial<Record<TemplatedNotificationType, Partial<SmsTemplate>>>;
}

/** The copy a store sends until the merchant changes it, in its checkout language. */
export function defaultNotificationTemplates(language: MessageLanguage): NotificationTemplates {
  const { greeting, events } = NOTIFICATION_DEFAULT_COPY[language];
  return {
    email: Object.fromEntries(TEMPLATED_NOTIFICATION_TYPES.map((event) => [event, {
      subject: events[event].subject,
      body: `${greeting}\n\n${events[event].message}`,
    }])) as Record<TemplatedNotificationType, EmailTemplate>,
    sms: Object.fromEntries(TEMPLATED_NOTIFICATION_TYPES.map((event) => [event, {
      body: `${greeting} ${events[event].sms}`,
    }])) as Record<TemplatedNotificationType, SmsTemplate>,
  };
}

/** Merchant changes (used as typed) over the defaults of the store's language. */
export function resolveNotificationTemplates(
  overrides: NotificationTemplateOverrides,
  language: MessageLanguage,
  /** The buyer's language as a store locale (`bn`); null: the store's default language. */
  locale?: string | null,
): NotificationTemplates {
  const defaults = defaultNotificationTemplates(language);
  const base: NotificationTemplates = {
    email: { ...defaults.email, ...overrides.email },
    sms: { ...defaults.sms, ...overrides.sms },
  };
  const version = locale ? overrides.languages?.[locale] : undefined;
  if (!locale || !version) return base;
  // One row per event, through the store's one fallback chain: the locale's
  // version, then the default-language template (the merchant's, else the platform's).
  const resolved: NotificationTemplates = { email: { ...base.email }, sms: { ...base.sms } };
  for (const event of TEMPLATED_NOTIFICATION_TYPES) {
    const row: TranslationRow = {
      locale,
      marketId: null,
      fields: Object.fromEntries(Object.entries({
        emailSubject: version.email[event]?.subject,
        emailBody: version.email[event]?.body,
        smsBody: version.sms[event]?.body,
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    };
    const chain = translationChain([row], { locale, marketId: null, defaultLocale: locale });
    resolved.email[event] = {
      subject: resolveTranslatedField(chain, "emailSubject", base.email[event].subject),
      body: resolveTranslatedField(chain, "emailBody", base.email[event].body),
    };
    resolved.sms[event] = { body: resolveTranslatedField(chain, "smsBody", base.sms[event].body) };
  }
  return resolved;
}

// The body excludes braces; trim its edges after matching so whitespace cannot
// be divided between overlapping repetitions on a malformed template.
const VARIABLE = /\{\{([^{}]*)\}\}/g;

/** Variables this event can't fill, as the merchant typed them. */
export function findUnknownVariables(template: string, event: TemplatedNotificationType): string[] {
  const allowed = new Set<string>(variablesForEvent(event));
  const unknown = new Set<string>();
  for (const match of template.matchAll(VARIABLE)) {
    const name = (match[1] ?? "").trim();
    if (!allowed.has(name)) unknown.add(name);
  }
  return [...unknown];
}

/** Where an empty variable was, while the line closes up around it. */
const HOLE = "\uE000";

/** The spaces and punctuation an empty variable leaves behind close up: "Hi {{customer_name}}, …" → "Hi, …". */
function closeUp(line: string): string {
  return line
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[([{"“‘][ \t]?\uE000[ \t]?[)\]}"”’]/g, HOLE)
    .replace(/[ \t]?\uE000[ \t]?(?=[,.;:!?।)\]}])/g, "")
    .replace(/[ \t]?\uE000[ \t]?/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([,;:·|–—-])(?:[ \t]*[,;:·|–—-])+/g, "$1")
    .replace(/[ \t]?[,;:·|–—-][ \t]?(?=[.!?।]|$)/g, "")
    .replace(/^[\s,.;:!?।·|–—-]+/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Fills one line's `{{variable}}`s. Values are single-line plain text; HTML
 * escaping happens where HTML is built. `blank` is true when the line uses
 * variables and none of them has a value.
 */
function fillLine(line: string, values: NotificationVariableValues): { text: string; blank: boolean } {
  let used = 0;
  let empty = 0;
  const filled = line.replace(VARIABLE, (_match, rawName: string) => {
    const name = rawName.trim();
    used += 1;
    const raw = Object.hasOwn(values, name) ? values[name as NotificationVariable] : undefined;
    const value = raw?.replace(/[\s\uE000]+/g, " ").trim();
    if (value) return value;
    empty += 1;
    return HOLE;
  });
  return empty ? { text: closeUp(filled), blank: empty === used } : { text: filled, blank: false };
}

/**
 * Fills a message (an email body or an SMS). A line whose variables are all
 * empty (a tracking ID that isn't known yet) is left out, so no message says
 * "Tracking: "; elsewhere an empty variable is left blank.
 */
export function renderTemplate(template: string, values: NotificationVariableValues): string {
  const lines: string[] = [];
  for (const line of template.replace(/\r\n?/g, "\n").split("\n")) {
    const { text, blank } = fillLine(line, values);
    if (!blank) lines.push(text);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Fills a subject: one line that is never left out; an empty variable is left blank. */
export function renderSubject(template: string, values: NotificationVariableValues): string {
  return fillLine(template.replace(/[\r\n]+/g, " "), values).text.trim();
}

/**
 * The email a customer gets for one event, as the real send, the test send and
 * the dashboard preview show it. A subject or message that renders empty uses
 * the event's default, so no email goes out without a subject.
 */
export function renderEmailTemplate(
  event: TemplatedNotificationType,
  language: MessageLanguage,
  template: EmailTemplate,
  values: NotificationVariableValues,
): EmailTemplate {
  const subject = renderSubject(template.subject, values);
  const body = renderTemplate(template.body, values);
  if (subject && body) return { subject, body };
  const fallback = defaultNotificationTemplates(language).email[event];
  return {
    subject: subject || renderSubject(fallback.subject, values),
    body: body || renderTemplate(fallback.body, values),
  };
}

/** The SMS a customer gets for one event; one that renders empty uses the event's default. */
export function renderSmsTemplate(
  event: TemplatedNotificationType,
  language: MessageLanguage,
  body: string,
  values: NotificationVariableValues,
): string {
  return renderTemplate(body, values)
    || renderTemplate(defaultNotificationTemplates(language).sms[event].body, values);
}

// ─────────────────────────────────────────
// Order email frame (customer and staff)
// ─────────────────────────────────────────

/** The store as an email shows it. */
export interface EmailStore {
  /** The store's display name (`storeDisplayName`); null only while nothing names the store. */
  name: string | null;
  /** The header logo, only when it is an absolute http(s) URL. */
  logoUrl: string | null;
}

export type EmailPayment =
  | { state: "refunded" | "partially_refunded" | "nothing_due" | "paid" | "partially_paid" | "not_completed" }
  | { state: "cod"; due: string | null; partiallyPaid: boolean; at: CashCollectionPoint }
  /** An invoice (net terms): what is left to pay and by when (the date in the store's language). */
  | { state: "invoice"; due: string | null; dueDate: string; days: number; partiallyPaid: boolean };

/** One order's facts for an email, money already formatted in its saved currency. */
export interface OrderEmailFacts {
  store: EmailStore;
  /** `unitPrice`/`subtotal` are null when the saved currency can't be shown. */
  /**
   * `properties` are the buyer's line inputs as display lines ("Engraving: Rahim"),
   * shown in the email only (never SMS); absent on lines without inputs.
   */
  items: Array<{
    name: string | null;
    variant: string | null;
    quantity: number;
    unitPrice: string | null;
    subtotal: string | null;
    properties?: readonly string[];
  }>;
  /**
   * The apps' checkout answers the buyer gave (a delivery day and window), by
   * app, each "Label: value" in the message's language
   * (`presentCheckoutAttributes`); email only. Absent without answers.
   */
  appAnswers?: ReadonlyArray<{ appName: string; lines: readonly string[] }>;
  /** Null when the saved currency can't be shown truthfully. */
  amounts: {
    subtotal: string;
    /** Each applied discount; `name` null is a discount without a saved promotion. */
    /** `appId`: a store app's discount (it keeps its own title); the store's own code discounts show their code. */
    discounts: Array<{ name: string | null; code: string | null; appId?: string | null; amount: string }>;
    /** What the buyer pays for delivery (null: free) and, when it was waived or discounted, the fee before that. */
    delivery: { amount: string | null; original: string | null };
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

/** Plain-text web addresses in the message (a courier tracking link) become links. */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (url) => `<a href="${url}" style="color:#174ea6;">${url}</a>`);
}

function bodyHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;">${linkify(escapeHtml(paragraph)).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function paymentLine(language: MessageLanguage, payment: EmailPayment): string {
  const copy = MESSAGE_COPY[language];
  switch (payment.state) {
    case "cod": return copy.cod(payment.due, payment.partiallyPaid, payment.at);
    case "invoice": return copy.invoice(payment.due, payment.dueDate, payment.days, payment.partiallyPaid);
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

  // Each discount by name and code; free or discounted delivery is the delivery
  // line itself, with the fee it replaced struck through.
  const summary: Array<{ label: string; value: string; was?: string | null }> = [];
  if (amounts) {
    summary.push({ label: copy.subtotal, value: amounts.subtotal });
    for (const discount of amounts.discounts) {
      summary.push({ label: formatDiscountLineLabel(copy.discount, { title: discount.name, code: discount.code, appId: discount.appId }), value: `−${discount.amount}` });
    }
    summary.push({ label: copy.shipping, value: amounts.delivery.amount ?? copy.free, was: amounts.delivery.original });
    if (amounts.tax) {
      summary.push({
        label: `${amounts.tax.label || copy.tax}${amounts.tax.included ? ` (${copy.taxIncluded})` : ""}`,
        value: amounts.tax.amount,
      });
    }
    summary.push({ label: copy.total, value: amounts.total });
  }
  const payment = paymentLine(language, facts.payment);
  const lines = facts.items.map((item) => ({
    name: item.name || copy.itemUnavailable,
    variant: item.variant,
    properties: (item.properties ?? []).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean),
    // The count in the message's digits, as its money (`formatMoney(..., { language })`).
    quantity: item.unitPrice
      ? `${formatNumber(item.quantity, numberLocale(language))} × ${item.unitPrice}`
      : copy.quantity(formatNumber(item.quantity, numberLocale(language))),
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
    ...lines.map((item) => `${item.name}${item.variant ? ` (${item.variant})` : ""}${item.properties.map((line) => `\n${line}`).join("")}\n${item.quantity}${item.subtotal ? ` — ${item.subtotal}` : ""}`),
    summary.map(({ label, value, was }) => `${label}: ${value}${was ? ` ${copy.was(was)}` : ""}`).join("\n"),
    amounts ? "" : copy.amountsUnavailable,
    `${copy.payment}: ${payment}`,
    facts.address.length ? `${copy.deliveryAddress}\n${facts.address.join("\n")}` : "",
    facts.method.length ? `${copy.deliveryMethod}\n${facts.method.join("\n")}` : "",
    ...(facts.appAnswers ?? []).map((group) => `${group.appName}\n${group.lines.join("\n")}`),
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
${lines.length ? `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><thead><tr><th scope="col" style="text-align:left;padding:0 8px 8px 0;${RULE}">${escapeHtml(copy.items)}</th><th scope="col" style="width:34%;text-align:right;padding:0 0 8px;${RULE}">${amounts ? escapeHtml(copy.subtotal) : ""}</th></tr></thead><tbody>${lines.map((item) => `<tr><td style="padding:12px 8px 12px 0;vertical-align:top;${RULE}"><strong>${escapeHtml(item.name)}</strong>${item.variant ? `<div style="${MUTED}">${escapeHtml(item.variant)}</div>` : ""}${item.properties.map((line) => `<div style="font-size:14px;${MUTED}">${escapeHtml(line)}</div>`).join("")}<div style="font-size:14px;${MUTED}">${escapeHtml(item.quantity)}</div></td><td style="padding:12px 0;vertical-align:top;text-align:right;${RULE}">${escapeHtml(item.subtotal)}</td></tr>`).join("")}</tbody></table>` : ""}
${summary.length ? `<table aria-label="${escapeHtml(copy.orderSummary)}" style="width:100%;border-collapse:collapse;margin:16px 0;">${summary.map(({ label, value, was }, index) => {
    const weight = index === summary.length - 1 ? "700" : "400";
    const before = was ? `<s style="${MUTED}">${escapeHtml(was)}</s> ` : "";
    return `<tr><th scope="row" style="padding:4px 12px 4px 0;text-align:left;font-weight:${weight};">${escapeHtml(label)}</th><td style="padding:4px 0;text-align:right;font-weight:${weight};">${before}${escapeHtml(value)}</td></tr>`;
  }).join("")}</table>` : `<p style="${MUTED}">${escapeHtml(copy.amountsUnavailable)}</p>`}
<p style="margin:16px 0 0;"><strong>${escapeHtml(copy.payment)}:</strong> ${escapeHtml(payment)}</p>
${facts.address.length ? `<h2 style="${SECTION}">${escapeHtml(copy.deliveryAddress)}</h2><p style="margin:0;">${facts.address.map((line) => escapeHtml(line)).join("<br>")}</p>` : ""}
${facts.method.length ? `<h2 style="${SECTION}">${escapeHtml(copy.deliveryMethod)}</h2><p style="margin:0;">${escapeHtml(facts.method[0]!)}${facts.method[1] ? `<br><span style="${MUTED}">${escapeHtml(facts.method[1])}</span>` : ""}</p>` : ""}
${(facts.appAnswers ?? []).map((group) => `<h2 style="${SECTION}">${escapeHtml(group.appName)}</h2><p style="margin:0;">${group.lines.map((line) => escapeHtml(line)).join("<br>")}</p>`).join("")}
${support.length ? `<div style="margin-top:24px;border-top:1px solid #dadce0;padding-top:16px;"><p style="margin:0 0 8px;">${escapeHtml(copy.needHelp)}</p>${support.map((contact) => `<p style="margin:4px 0;"><a href="${escapeHtml(contact.href)}" style="${LINK}">${escapeHtml(contact.label)}</a></p>`).join("")}</div>` : ""}
</div></body></html>`;
  return { subject, html, text };
}

/**
 * A message that is not an order summary (a gift card, a digital delivery, a
 * review request, a staff alert): the store header, the subject, the rendered
 * body with its web addresses as links, and an optional button.
 */
export function renderMessageEmail(input: {
  language: MessageLanguage;
  store: EmailStore;
  /** Rendered subject (plain text). */
  subject: string;
  /** Rendered body (plain text; blank lines separate paragraphs). */
  body: string;
  action?: { label: string; href: string } | null;
}): { subject: string; html: string; text: string } {
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
  const action = input.action ?? null;
  const text = [
    input.store.name,
    subject,
    input.body,
    action ? `${action.label}: ${action.href}` : "",
  ].filter(Boolean).join("\n\n");
  const html = `<!doctype html><html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${storeHeaderHtml(input.store)}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;">${escapeHtml(subject)}</h1>
<div style="margin:0 0 8px;">${bodyHtml(input.body)}</div>
${action ? `<p style="margin:0 0 12px;"><a href="${escapeHtml(action.href)}" style="${BUTTON}">${escapeHtml(action.label)}</a></p>` : ""}
</div></body></html>`;
  return { subject, html, text };
}

// ─────────────────────────────────────────
// Sample order for the dashboard preview and test sends
// ─────────────────────────────────────────

export function sampleVariables(storeName: string, language: MessageLanguage): NotificationVariableValues {
  const copy = MESSAGE_COPY[language];
  // Sample money in the message's digits, as a real send writes it.
  const money = (amount: number) => formatMoney(amount, { code: "BDT", language });
  return {
    customer_name: "Rahim Uddin",
    order_number: "#1001",
    order_total: money(1250),
    cod_amount: money(1250),
    store_name: storeName,
    tracking_id: "SF12345678",
    courier_name: "Steadfast",
    tracking_url: "https://steadfast.com.bd/t/SF12345678",
    refund_amount: money(450),
    support_request: copy.request.return,
    support_status: copy.requestStatus.approved,
    download_names: "Recipe book.pdf",
    licence_keys: "SAMPLE-KEY-0000",
    sms_licence_keys: "SAMPLE-KEY-0000",
    access_link: "https://example.com/account/downloads",
    review_products: "Cotton panjabi",
    review_link: "https://example.com/account/orders/1001#reviews",
    gift_card_code: "SAMPLE0000000000",
    gift_card_value: money(1000),
    gift_card_expires: "",
    gift_card_message: "Happy Eid!",
    gift_card_sender: "Karim",
    gift_card_link: "https://example.com/",
  };
}

/**
 * A draft template with sample data in the real email frame, for the
 * dashboard preview and test emails: the order summary for order events, the
 * plain message frame for the digital, gift card and review messages (the
 * frame their real send uses).
 */
export function sampleOrderEmail(options: {
  event: TemplatedNotificationType;
  language: MessageLanguage;
  store: EmailStore;
  template: EmailTemplate;
  /** The storefront origin, so the preview shows the guest's order link. */
  origin?: string | null;
}): { subject: string; html: string; text: string } {
  const origin = trimTrailingCharacter(options.origin ?? "", "/") || null;
  const values = sampleVariables(options.store.name ?? "", options.language);
  const money = (amount: number) => formatMoney(amount, { code: "BDT", language: options.language });
  if (isResolvedNotificationType(options.event)) {
    return renderMessageEmail({
      language: options.language,
      store: options.store,
      ...renderEmailTemplate(options.event, options.language, options.template, values),
    });
  }
  return renderOrderEmail({
    language: options.language,
    ...renderEmailTemplate(options.event, options.language, options.template, values),
    facts: {
      store: options.store,
      items: [{ name: "Cotton panjabi", variant: "L", quantity: 1, unitPrice: money(1350), subtotal: money(1350) }],
      amounts: {
        subtotal: money(1350),
        discounts: [{ name: "Eid sale", code: "EID10", amount: money(100) }],
        delivery: { amount: null, original: money(60) },
        tax: null,
        total: money(1250),
      },
      payment: { state: "cod", due: money(1250), partiallyPaid: false, at: "delivery" },
      address: ["Rahim Uddin", "01712-345678", "House 12, Road 5", "Dhanmondi, Dhaka"],
      method: ["Inside Dhaka"],
      origin,
      orderLink: origin ? { kind: "track", href: `${origin}/track-order?order=1001` } : null,
      support: [],
    },
  });
}
