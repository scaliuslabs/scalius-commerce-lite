// Deferred payment (net terms): an order placed now and paid later, by a due
// date. One vocabulary for checkout, staff and app orders, the dashboard, the
// buyer's pages and emails. Browser-safe.
//
// - The built-in method is `net_terms` ("Invoice / net terms"): the merchant
//   picks the days (net 7, 15, 30 or 60) and who may use it (customer tags,
//   segments, or an app's `checkout.payment_methods` decision). It is never
//   offered to a guest.
// - An app may declare its own deferred method (`flow: "deferred"` with
//   `dueInDays` in its payment provider descriptor); it is offered to
//   signed-in buyers only.
// - A deferred order commits with its payment unpaid, its stock reserved as
//   for cash on delivery, `payment_terms_days` and `payment_due_at`
//   (placement + days). It is paid later by a recorded payment (staff or the
//   app API) and is overdue once its due date passes with money still due.
import { z } from "zod";

/** The built-in deferred method: an invoice paid within the merchant's net days. */
export const NET_TERMS_PAYMENT_METHOD = "net_terms";
/** Its default name; buyers see "Invoice (net 30)" (`netTermsLabel`). */
export const NET_TERMS_LABEL = "Invoice / net terms";

/** The net terms a merchant picks for the built-in method. */
export const NET_TERMS_DAYS = [7, 15, 30, 60] as const;
export type NetTermsDays = (typeof NET_TERMS_DAYS)[number];
export const DEFAULT_NET_TERMS_DAYS: NetTermsDays = 30;

/** The longest terms any deferred order carries (staff, apps and app methods). */
export const PAYMENT_TERMS_MAX_DAYS = 365;

const DAY_SECONDS = 86_400;

/** An order's terms on the wire: `{ kind: "net", days }`. */
export const paymentTermsSchema = z.object({
  kind: z.literal("net"),
  days: z.number().int().min(1).max(PAYMENT_TERMS_MAX_DAYS),
}).strict();
export type PaymentTerms = z.infer<typeof paymentTermsSchema>;

export function isPaymentTermsDays(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= PAYMENT_TERMS_MAX_DAYS;
}

export function isNetTermsDays(value: unknown): value is NetTermsDays {
  return (NET_TERMS_DAYS as readonly unknown[]).includes(value);
}

/**
 * Who may pay by the built-in invoice (Settings → Payments). A signed-in
 * customer with one of `customerTags`, or in one of `segmentIds`, is offered
 * it; with `appsDecide`, an installed app's `checkout.payment_methods`
 * function may also allow it (`{ op: "allow" }`) for a buyer neither list
 * names. Nobody else is offered it, and a guest never is.
 */
export interface NetTermsSettings {
  dueInDays: NetTermsDays;
  customerTags: string[];
  segmentIds: string[];
  appsDecide: boolean;
}

export const NET_TERMS_TAGS_MAX = 20;
export const NET_TERMS_SEGMENTS_MAX = 10;

export const DEFAULT_NET_TERMS_SETTINGS: NetTermsSettings = {
  dueInDays: DEFAULT_NET_TERMS_DAYS,
  customerTags: [],
  segmentIds: [],
  appsDecide: false,
};

/** A customer tag as Customers → Tags stores it: lowercase, at most 40 characters. */
const tag = z.string().trim().toLowerCase().min(1).max(40);
const segmentId = z.string().trim().min(1).max(128);

/** The settings as staff save them (strict). */
export const netTermsSettingsSchema = z.object({
  dueInDays: z.union([z.literal(7), z.literal(15), z.literal(30), z.literal(60)]),
  customerTags: z.array(tag).max(NET_TERMS_TAGS_MAX).transform((tags) => [...new Set(tags)]),
  segmentIds: z.array(segmentId).max(NET_TERMS_SEGMENTS_MAX).transform((ids) => [...new Set(ids)]),
  appsDecide: z.boolean(),
}).strict();

/** A stored value read leniently: anything unreadable falls back to nobody eligible. */
export function readNetTermsSettings(value: unknown): NetTermsSettings {
  const parsed = netTermsSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_NET_TERMS_SETTINGS };
}

/** Whether the settings name anyone at all (an enabled method with nobody eligible offers nothing). */
export function netTermsNamesAnyone(settings: NetTermsSettings): boolean {
  return settings.customerTags.length > 0 || settings.segmentIds.length > 0 || settings.appsDecide;
}

/** The due date of terms of `days` from `placedAtSeconds` (unix seconds). */
export function paymentDueAtSeconds(placedAtSeconds: number, days: number): number {
  return placedAtSeconds + days * DAY_SECONDS;
}

/** Whether a deferred order is overdue: its due date passed and money is still due. */
export function isPaymentOverdue(order: {
  paymentDueAt: Date | number | null | undefined;
  balanceDueMinor: number;
}, now: Date | number = Date.now()): boolean {
  if (order.paymentDueAt === null || order.paymentDueAt === undefined || order.balanceDueMinor <= 0) return false;
  const due = typeof order.paymentDueAt === "number" ? order.paymentDueAt * 1_000 : order.paymentDueAt.getTime();
  const at = typeof now === "number" ? now : now.getTime();
  return due <= at;
}

/** How a recorded (offline) payment reached the merchant. */
export const RECORDED_PAYMENT_VIAS = ["bank_transfer", "cash", "cheque", "card_terminal", "mobile_wallet", "other"] as const;
export type RecordedPaymentVia = (typeof RECORDED_PAYMENT_VIAS)[number];

/**
 * `order_payments.payment_method` of a payment staff or an app recorded (a
 * bank transfer against an invoice): not a gateway, refunded as a confirmed
 * manual settlement like cash on delivery.
 */
export const RECORDED_PAYMENT_METHOD = "manual";
