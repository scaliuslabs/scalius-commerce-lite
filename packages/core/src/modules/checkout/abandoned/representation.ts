// Abandoned checkouts as apps and webhooks see them (`EVENT_REPRESENTATION_SCHEMAS.checkout`),
// read for a page of ids in one batch: the snapshot rows, and the live
// customer records with the snapshots' phones and their marketing consents
// (every list bound as one JSON value). Money comes out in minor units of
// the page's currency (the store's when an older snapshot did not say).
// The recovery link is signed only when the caller passes the runtime.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { abandonedCheckouts, customerMarketingConsents, customers } from "@scalius/database/schema";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { MAX_MINOR_AMOUNT } from "@scalius/shared/money";
import { buildEventRepresentation, type EventRepresentation } from "@scalius/shared/events";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";
import { inJsonArray } from "../../../utils/in-json-array";
import { readStoreCurrency } from "../../markets";
import { checkoutRecoveryLink, type CheckoutRecoveryEnv } from "./recovery";

/** Checkouts one read takes: a page of a list (D1 binds the list as one value). */
export const ABANDONED_CHECKOUT_REPRESENTATIONS_MAX = 90;

export interface CheckoutRecoveryRuntime {
  env: CheckoutRecoveryEnv;
  storefrontUrl: string | null | undefined;
}

type Snapshot = Record<string, unknown>;

const record = (value: unknown): Snapshot | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Snapshot : null);
const string = (value: unknown, max = 500): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const iso = (value: Date | null | undefined): string | null => (value && Number.isFinite(value.getTime()) ? value.toISOString() : null);

function parse(json: string): Snapshot {
  try {
    return record(JSON.parse(json)) ?? {};
  } catch {
    return {};
  }
}

/** A snapshot's major-unit amount in minor units (never negative, never past the money bound). */
function minor(value: unknown, places: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_MINOR_AMOUNT, Math.round(value * 10 ** places))
    : 0;
}

/** The checkout's lines: the snapshot's well-formed cart items (`normalizeAbandonedCheckoutSnapshot`). */
function lines(snapshot: Snapshot, places: number): EventRepresentation<"checkout">["lines"] {
  const items = record(snapshot.cart)?.items;
  return (Array.isArray(items) ? items : []).flatMap((value) => {
    const item = record(value);
    const productId = string(item?.id, 128);
    const quantity = typeof item?.quantity === "number" && Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 0;
    if (!item || !productId || quantity === 0) return [];
    const unitPriceMinor = minor(item.price, places);
    return [{
      productId,
      variantId: string(item.variantId, 128),
      title: string(item.name, 200) ?? "",
      options: (Array.isArray(item.options) ? item.options : []).flatMap((option) => {
        const name = string(record(option)?.name, 100);
        const value = string(record(option)?.value, 200);
        return name && value ? [{ name, value }] : [];
      }),
      quantity,
      unitPriceMinor,
      totalMinor: Math.min(MAX_MINOR_AMOUNT, unitPriceMinor * quantity),
    }];
  });
}

/** These checkouts, in the order asked; unknown ids (recovered or cleaned up) are left out. */
export async function readAbandonedCheckoutRepresentations(
  db: Database,
  ids: readonly string[],
  runtime?: CheckoutRecoveryRuntime,
): Promise<EventRepresentation<"checkout">[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > ABANDONED_CHECKOUT_REPRESENTATIONS_MAX) throw new RangeError(`Read at most ${ABANDONED_CHECKOUT_REPRESENTATIONS_MAX} checkouts at once.`);
  const rows = await db.select().from(abandonedCheckouts).where(inJsonArray(abandonedCheckouts.id, unique));
  if (rows.length === 0) return [];
  const phones = [...new Set(rows.flatMap((row) => row.customerPhone ? [row.customerPhone] : []))];
  const [store, people] = await Promise.all([
    readStoreCurrency(db),
    phones.length === 0 ? Promise.resolve([]) : db.select({
      id: customers.id,
      phone: customers.phone,
      claimed: sql<number>`${customers.accountClaimedAt} IS NOT NULL`,
      channel: customerMarketingConsents.channel,
      state: customerMarketingConsents.state,
    }).from(customers)
      .leftJoin(customerMarketingConsents, eq(customerMarketingConsents.customerId, customers.id))
      // `+deleted_at`: the phone list, not the live-row index, drives the read.
      .where(and(inJsonArray(customers.phone, phones), sql`+${customers.deletedAt} IS NULL`, isNull(customers.mergedIntoCustomerId))),
  ]);
  // The phone's record as checkout files a guest under it: the unclaimed
  // profile first, else the account (`ABANDONED-CHECKOUTS-CUSTOMERS.md`).
  const byPhone = new Map<string, { id: string; claimed: boolean; consents: Array<{ channel: string; state: string }> }>();
  for (const person of people) {
    const claimed = Boolean(Number(person.claimed));
    let entry = byPhone.get(person.phone);
    if (!entry || (entry.claimed && !claimed)) {
      entry = { id: person.id, claimed, consents: [] };
      byPhone.set(person.phone, entry);
    }
    if (entry.id === person.id && person.channel && person.state) entry.consents.push({ channel: person.channel, state: person.state });
  }
  const built = await Promise.all(rows.map(async (row) => {
    const snapshot = parse(row.checkoutData);
    const currency = string(snapshot.currency, 3) ?? store.code;
    const places = getDecimalPlaces(currency);
    const presence = string(snapshot.presence, 64);
    const cartLines = lines(snapshot, places);
    const subtotalMinor = Math.min(MAX_MINOR_AMOUNT, cartLines.reduce((sum, line) => sum + line.totalMinor, 0));
    const discountMinor = Math.min(subtotalMinor, minor(record(record(snapshot.cart)?.discount)?.discountAmount, places));
    const shipping = record(snapshot.shipping);
    const shippingMinor = shipping && typeof shipping.fee === "number" ? minor(shipping.fee, places) : null;
    const customer = row.customerPhone ? byPhone.get(row.customerPhone) ?? null : null;
    const link = runtime ? await checkoutRecoveryLink(runtime, { id: row.id, updatedAt: row.updatedAt, presence }) : null;
    return [row.id, buildEventRepresentation("checkout", {
      id: row.id,
      checkoutId: row.checkoutId,
      status: row.abandonedAt ? "abandoned" : "open",
      customerId: customer?.id ?? null,
      name: string(snapshot.customerName, 160),
      email: string(snapshot.customerEmail, 320),
      phone: row.customerPhone ?? null,
      currency,
      presence,
      language: string(snapshot.language, 16),
      lines: cartLines,
      subtotalMinor,
      discountMinor,
      shippingMinor,
      totalMinor: Math.min(MAX_MINOR_AMOUNT, subtotalMinor - discountMinor + (shippingMinor ?? 0)),
      marketingConsents: (customer?.consents ?? []).sort((left, right) => left.channel.localeCompare(right.channel)),
      recoveryUrl: link?.url ?? null,
      recoveryExpiresAt: iso(link?.expiresAt),
      abandonedAt: iso(row.abandonedAt),
      createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
      updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    }, allProtectedData())] as const;
  }));
  const byId = new Map(built);
  return unique.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The lines a valid recovery link puts back in a cart: product, variant,
 * quantity and the snapshot's display facts (the store prices and checks
 * them again), with the market presence; null for a checkout that is gone.
 */
export async function readAbandonedCheckoutRecovery(db: Database, id: string): Promise<{
  presence: string | null;
  lines: Array<{ productId: string; variantId: string | null; quantity: number; title: string; slug: string | null }>;
} | null> {
  const row = await db.select({ data: abandonedCheckouts.checkoutData }).from(abandonedCheckouts).where(eq(abandonedCheckouts.id, id)).get();
  if (!row) return null;
  const snapshot = parse(row.data);
  const items = record(snapshot.cart)?.items;
  const slugs = new Map((Array.isArray(items) ? items : []).flatMap((item) => {
    const slug = string(record(item)?.slug, 200);
    return slug ? [[string(record(item)?.id, 128), slug] as const] : [];
  }));
  return {
    presence: string(snapshot.presence, 64),
    lines: lines(snapshot, 0).map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      title: line.title,
      slug: slugs.get(line.productId) ?? null,
    })),
  };
}
