// Seller accounts: onboarding (an application from the portal, or staff
// adding a seller), approval and suspension, and which seller owns a
// product. A product's seller lives in three places, written together:
// the `product_sellers` record (what checkout and the order split read),
// and the product's public `seller_name`/`seller_handle` fields (what cards
// and the product page show). The public profile (`seller_profiles`) is
// published only while the seller is approved.

import type { PluginContext } from "@scalius/plugin-sdk";
import {
  HANDLE_PATTERN,
  errorCode,
  handleFrom,
  plain,
  productSellers,
  profiles,
  sellerIdOf,
  sellers,
  type Seller,
  type SellerStatus,
} from "./model";

export interface Application {
  name: string;
  handle?: string;
  email?: string | null;
  about?: string | null;
  customerId?: string | null;
  commissionBps?: number | null;
}

export type ApplyResult =
  | { ok: true; id: string; seller: Seller }
  | { ok: false; errors: Record<string, string> };

/** Validates and stores an application (status `pending`), or a seller staff add directly (`approved`). */
export async function createSeller(ctx: PluginContext, input: Application, status: "pending" | "approved"): Promise<ApplyResult> {
  const name = plain(input.name, 80);
  const handle = (input.handle ? plain(input.handle, 50).toLowerCase() : "") || handleFrom(name);
  const email = input.email ? plain(input.email, 200) : null;
  const errors: Record<string, string> = {};
  if (name.length < 2) errors.name = "Give the shop a name of at least two letters.";
  if (!HANDLE_PATTERN.test(handle)) errors.handle = "Use lower-case letters, digits and dashes.";
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter an email address.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (input.customerId) {
    const existing = await sellers(ctx).query({ where: { customer_id: input.customerId }, limit: 1 });
    if (existing.records[0]) return { ok: false, errors: { name: "This account already has a seller shop." } };
  }
  const now = Date.now();
  const seller: Seller = {
    name,
    handle,
    email,
    customer_id: input.customerId ?? null,
    status,
    commission_bps: typeof input.commissionBps === "number" && Number.isFinite(input.commissionBps) ? Math.max(0, Math.min(10_000, Math.round(input.commissionBps))) : null,
    about: input.about ? plain(input.about, 600) : null,
    created_at: now,
    approved_at: status === "approved" ? now : null,
  };
  const id = sellerIdOf(handle);
  try {
    await sellers(ctx).put(id, seller, { expectedRevision: null });
  } catch (error) {
    const code = errorCode(error);
    if (code === "object.conflict" || code === "object.unique_violation") return { ok: false, errors: { handle: "That shop address is taken. Choose another." } };
    throw error;
  }
  if (status === "approved") await publishProfile(ctx, id, seller);
  return { ok: true, id, seller };
}

async function publishProfile(ctx: PluginContext, id: string, seller: Seller): Promise<void> {
  await profiles(ctx).put(id, { name: seller.name, about: seller.about ?? "", seller_id: id }, { handle: seller.handle, status: seller.status === "approved" ? "published" : "draft" });
}

/** Moves a seller to a new status: its profile follows, and so does every product record's denormalized status. */
export async function setSellerStatus(ctx: PluginContext, id: string, status: SellerStatus): Promise<Seller | null> {
  const current = await sellers(ctx).getVersion(id);
  if (!current) return null;
  if (current.data.status === status) return current.data;
  const next: Seller = { ...current.data, status, ...(status === "approved" && !current.data.approved_at ? { approved_at: Date.now() } : {}) };
  await sellers(ctx).put(id, next, { expectedRevision: current.revision });
  await publishProfile(ctx, id, next);
  // Bounded: 100 products per pass; a larger catalogue converges on the next status change or reassignment.
  const owned = await productSellers(ctx).query({ where: { seller_id: id }, limit: 100 });
  for (const record of owned.records) {
    if (record.data.seller_status !== status) await productSellers(ctx).update(record.id, { seller_status: status });
  }
  return next;
}

/** Makes a seller the owner of a product (null: the store sells it again). */
export async function assignProduct(ctx: PluginContext, productId: string, sellerId: string | null): Promise<{ ok: boolean; message: string }> {
  if (!sellerId) {
    await productSellers(ctx).delete(productId);
    await ctx.customFields.set("product", productId, { seller_name: null, seller_handle: null, seller_id: null });
    return { ok: true, message: "The store sells this product again." };
  }
  const seller = await sellers(ctx).get(sellerId);
  if (!seller) return { ok: false, message: "That seller does not exist." };
  if (seller.status !== "approved") return { ok: false, message: "Approve the seller before giving them products." };
  await productSellers(ctx).put(productId, { seller_id: sellerId, seller_name: seller.name, seller_status: seller.status, assigned_at: Date.now() });
  await ctx.customFields.set("product", productId, { seller_name: seller.name, seller_handle: seller.handle, seller_id: sellerId });
  return { ok: true, message: `${seller.name} now sells this product.` };
}

/** The seller account a signed-in customer owns, if any. */
export async function sellerOfCustomer(ctx: PluginContext, customerId: string): Promise<{ id: string; seller: Seller } | null> {
  const page = await sellers(ctx).query({ where: { customer_id: customerId }, limit: 1 });
  const record = page.records[0];
  return record ? { id: record.id, seller: record.data } : null;
}
