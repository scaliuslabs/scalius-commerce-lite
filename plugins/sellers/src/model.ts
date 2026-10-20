// The Sellers app's records and their rules, shared by the event handlers,
// the dashboard pages, the seller portal and the checkout function.
// Money is integer minor units of the order's currency throughout.

import type { PluginContext, PluginObjectCollection } from "@scalius/plugin-sdk";

export const PLUGIN_ID = "scalius.sellers";

export const SELLER_STATUSES = ["pending", "approved", "suspended", "rejected"] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

export const SPLIT_STATUSES = ["open", "paid", "fulfilled", "cancelled", "refunded"] as const;
export type SplitStatus = (typeof SPLIT_STATUSES)[number];

export const PAYOUT_STATUSES = ["draft", "approved", "paid"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** A seller account. Record id: `sel_<handle>`. */
export interface Seller extends Record<string, unknown> {
  name: string;
  handle: string;
  email: string | null;
  /** The store customer who signs in to the seller portal. */
  customer_id: string | null;
  status: SellerStatus;
  /** Commission in basis points (1250 = 12.5%); null takes the app's default. */
  commission_bps: number | null;
  about: string | null;
  created_at: number;
  approved_at: number | null;
}

/** A product's seller. Record id: the product id. Denormalized name and status keep checkout and cards one read away. */
export interface ProductSeller extends Record<string, unknown> {
  seller_id: string;
  seller_name: string;
  seller_status: SellerStatus;
  assigned_at: number;
}

export interface SplitLine {
  line_id: string;
  product_id: string;
  variant_id: string | null;
  title: string;
  quantity: number;
  subtotal_minor: number;
}

/** One seller's part of one order. Record id: `<order id>~<seller id>`. */
export interface OrderSplit extends Record<string, unknown> {
  order_id: string;
  order_number: number | null;
  seller_id: string;
  status: SplitStatus;
  lines: SplitLine[];
  item_count: number;
  subtotal_minor: number;
  commission_minor: number;
  net_minor: number;
  currency: string;
  created_at: number;
  /** The payout that settles it; null until one does. */
  payout_id: string | null;
}

/** A settlement of a seller's fulfilled splits. Record id: `<seller id>~<period end day>~<run>`. */
export interface Payout extends Record<string, unknown> {
  seller_id: string;
  period_end: number;
  gross_minor: number;
  commission_minor: number;
  net_minor: number;
  currency: string;
  split_count: number;
  status: PayoutStatus;
  created_at: number;
  paid_at: number | null;
  reference: string | null;
}

function collection<T extends Record<string, unknown>>(ctx: PluginContext, name: string): PluginObjectCollection<T> {
  const value = ctx.objects[name];
  if (!value) throw new Error(`The ${name} object is not declared.`);
  return value as unknown as PluginObjectCollection<T>;
}

export const sellers = (ctx: PluginContext) => collection<Seller>(ctx, "sellers");
export const productSellers = (ctx: PluginContext) => collection<ProductSeller>(ctx, "product_sellers");
export const splits = (ctx: PluginContext) => collection<OrderSplit>(ctx, "order_splits");
export const payouts = (ctx: PluginContext) => collection<Payout>(ctx, "payouts");
export const profiles = (ctx: PluginContext) => collection<Record<string, unknown>>(ctx, "seller_profiles");

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
export const sellerIdOf = (handle: string) => `sel_${handle}`;
export const splitIdOf = (orderId: string, sellerId: string) => `${orderId}~${sellerId}`;

/** A handle from a shop name: lower-case words joined by dashes, at most 50 characters. */
export function handleFrom(name: string): string {
  return name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
}

/** The commission rate for a seller: its own, else the app's default, clamped to 0-100%. */
export function commissionBps(seller: Pick<Seller, "commission_bps">, settings: Readonly<Record<string, unknown>>): number {
  const own = seller.commission_bps;
  const fallback = Number(settings.default_commission_bps ?? 1000);
  const value = typeof own === "number" && Number.isFinite(own) ? own : Number.isFinite(fallback) ? fallback : 1000;
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

/** The store's commission on an amount, rounded half up to the minor unit. */
export function commissionOf(amountMinor: number, bps: number): number {
  return Math.floor((amountMinor * bps + 5_000) / 10_000);
}

/** Splits count toward a payout once fulfilled; cancelled and refunded ones never do. */
export const payable = (split: Pick<OrderSplit, "status" | "payout_id">) => split.status === "fulfilled" && !split.payout_id;

/** Plain text for one line of a dashboard table or an email. */
export function plain(value: unknown, max = 120): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** The error code a platform refusal carries (`object.conflict`). */
export const errorCode = (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "");

/** Formats integer minor units for an email or a portal page, in the store's decimals (no locale: the portal formats with the SDK). */
export function minorToMajor(amountMinor: number, decimalPlaces: number): string {
  const places = Math.max(0, Math.min(4, decimalPlaces));
  const sign = amountMinor < 0 ? "-" : "";
  const whole = Math.abs(amountMinor);
  if (places === 0) return `${sign}${whole}`;
  const factor = 10 ** places;
  return `${sign}${Math.floor(whole / factor)}.${String(whole % factor).padStart(places, "0")}`;
}
