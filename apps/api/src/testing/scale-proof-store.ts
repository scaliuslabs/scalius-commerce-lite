/**
 * The queries of the scale proof (scripts/scale-proof.test.ts), kept here so they resolve the API's own
 * dependencies: they run through the application's Drizzle client, so one source serves D1 and PostgreSQL.
 */
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
  categories,
  customers,
  deliveryZoneRegions,
  deliveryZones,
  orderItems,
  orders,
  places,
  productVariants,
  products,
  shippingMethods,
} from "@scalius/database/schema";

export interface CheckoutLine {
  productId: string;
  variantId: string;
  /** Major units, as the storefront sends it. */
  price: number;
}

/** How big the store is: the proof states it beside every number. */
export async function storeSize(db: Database): Promise<Record<string, number>> {
  const total = async (rows: PromiseLike<Array<{ n: number }>>) => Number((await rows)[0]!.n);
  return {
    orders: await total(db.select({ n: count() }).from(orders)),
    orderItems: await total(db.select({ n: count() }).from(orderItems)),
    products: await total(db.select({ n: count() }).from(products)),
    skus: await total(db.select({ n: count() }).from(productVariants)),
    customers: await total(db.select({ n: count() }).from(customers)),
  };
}

/** A product page, a published category and a search word that exist in the store. */
export async function readTargets(db: Database): Promise<{ productSlug: string; categorySlug: string; term: string }> {
  const live = and(eq(products.isActive, true), isNull(products.deletedAt));
  const published = eq(categories.status, "published");
  const productCount = Number((await db.select({ n: count() }).from(products).where(live))[0]!.n);
  const categoryCount = Number((await db.select({ n: count() }).from(categories).where(published))[0]!.n);
  // Mid-catalogue, so the page is neither the newest nor an outlier.
  const [product] = await db.select({ slug: products.slug, name: products.name }).from(products)
    .where(live).orderBy(products.id).limit(1).offset(Math.floor(productCount * 0.4));
  const [category] = await db.select({ slug: categories.slug }).from(categories)
    .where(published).orderBy(categories.id).limit(1).offset(Math.floor(categoryCount * 0.3));
  if (!product || !category) throw new Error("The store has no product or category to read: seed it first.");
  return { productSlug: product.slug, categorySlug: category.slug, term: (product.name.split(/\s+/)[0] ?? "shirt").toLowerCase() };
}

/** Whole-taka, in-stock, single-SKU lines (cash on delivery collects whole taka), spread over the catalogue. */
export async function checkoutLines(db: Database, wanted: number): Promise<CheckoutLine[]> {
  const rows = await db.select({ productId: productVariants.productId, variantId: productVariants.id, priceMinor: productVariants.priceMinor })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(
      eq(products.isActive, true), isNull(products.deletedAt), eq(productVariants.isDefault, true),
      eq(productVariants.trackInventory, true), gt(productVariants.stock, 50),
      sql`${productVariants.priceMinor} % 100 = 0`, gt(productVariants.priceMinor, 0),
      // Full price: a discounted SKU's cart price is not its list price.
      eq(products.discountBps, 0), eq(products.discountAmountMinor, 0), eq(productVariants.discountBps, 0), eq(productVariants.discountAmountMinor, 0),
    ))
    .orderBy(productVariants.id)
    .limit(wanted * 3);
  return rows.filter((_, index) => index % 3 === 0).slice(0, wanted)
    .map((row) => ({ productId: row.productId, variantId: row.variantId, price: row.priceMinor / 100 }));
}

/** A delivery zone, its places and a shipping method, so the seeded store can take orders. */
export async function ensureDelivery(db: Database): Promise<void> {
  const place = { countryCode: "BD", externalIds: "{}", metadata: "{}", isActive: true } as const;
  await db.insert(places).values({ ...place, id: "scale_city", level: 1, parentId: null, name: "Scale City" }).onConflictDoNothing();
  await db.insert(places).values({ ...place, id: "scale_zone", level: 2, parentId: "scale_city", name: "Scale Zone" }).onConflictDoNothing();
  await db.insert(deliveryZones).values({ id: "scale_dz", name: "Scale Bangladesh" }).onConflictDoNothing();
  await db.insert(deliveryZoneRegions).values({ countryCode: "BD", zoneId: "scale_dz" }).onConflictDoNothing();
  await db.insert(shippingMethods).values({ id: "scale_std", name: "Scale Standard", feeMinor: 6000, kind: "delivery", zoneId: "scale_dz" }).onConflictDoNothing();
}

/** A SKU that cannot sell out mid-run: the hot-SKU scenario measures contention, not stock-out. */
export async function stockUp(db: Database, variantId: string): Promise<void> {
  await db.update(productVariants).set({ stock: 10_000_000 }).where(eq(productVariants.id, variantId));
}
