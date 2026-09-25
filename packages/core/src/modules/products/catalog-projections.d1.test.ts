// Drift test for the catalogue projections (product_buyer_state,
// product_facet_values): a seeded random walk of product, SKU, stock and
// checkout writes through the real services, on the real migrated schema.
// After every step the stored projections must equal a fresh computation
// from their sources: the unscoped live pricing projection and public
// eligibility predicate (the SQL the listings used before), the shared
// availability band, and the shared facet-key rules in TypeScript. A write
// path that forgot to append the refresh to its batch shows up here.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { products } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { resolveBuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
import {
    attributeFacetValueKey,
    optionFacetKey,
    type TypedAttributeValue,
} from "@scalius/shared/catalog-attributes";
import { normalizeProductOptionIdentity } from "@scalius/shared/product-options";

import { AppError } from "../../errors";
import { buildBuyerCatalogPricingProjection } from "./buyer-projection";
import { publicProductHasBuyerResolvableSku } from "./public-eligibility";
import {
    catalogProjectionRefreshStatements,
    rebuildCatalogProjections,
} from "./catalog-projections";
import { createProduct, duplicateProduct, updateProduct } from "./admin/write";
import { bulkUpdateProducts, deleteProduct, restoreProduct } from "./admin/lifecycle";
import { getProductDetails } from "./admin/read";
import { createProductSchema, updateProductSchema } from "./validation";
import { deleteVariant, updateVariant } from "./variants";
import { updateProductSemanticSection } from "./semantic-sections";
import { adjustStock, setStock } from "../inventory/stock-adjustment";
import { setLowStockThreshold } from "../inventory/alerts";
import { releaseExpiredReservations } from "../inventory/expiry";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "../checkout/attempts";
import { loadStorefrontCheckoutAuthority } from "../checkout/authority";
import { commitStorefrontOrderPayload } from "../checkout/commit";
import { createStorefrontOrder, createTrustedStorefrontCheckoutPolicySnapshot } from "../checkout/prepare";
import type { CreateStorefrontOrderInput } from "../orders/types";

// Alerts write their own rows; they are not what this test is about.
vi.mock("../inventory/alerts", async (importOriginal) => ({
    ...await importOriginal<typeof import("../inventory/alerts")>(),
    checkAndAlertLowStock: vi.fn(async () => ({ isLow: false, alertCreated: false })),
}));

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES
            ('cat_a', 'Shirts', 'shirts', 'published'), ('cat_b', 'Shoes', 'shoes', 'published');
        INSERT INTO product_attributes (id, name, slug, filterable) VALUES
            ('attr_material', 'Material', 'material', 1), ('attr_fit', 'Fit', 'fit', 1);
        INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
        VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
        INSERT INTO shipping_methods (id, name, fee_minor, kind) VALUES ('m_ship', 'Standard', 6000, 'delivery');
        INSERT INTO brands (id, name, slug, status) VALUES
            ('brd_walton01', 'Walton', 'walton', 'published'), ('brd_minister1', 'Minister', 'minister', 'draft');
        INSERT INTO brands (id, name, slug, status, deleted_at) VALUES ('brd_trashed1', 'Gone', 'gone', 'draft', 1);
    `);
});

afterEach(() => sqlite.close());

// ── The fresh computation ────────────────────────────────────────────────

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type BuyerStateRow = {
    product_id: string;
    is_public: number;
    category_id: string | null;
    brand_id: string | null;
    product_created_at: number;
    sku_id: string | null;
    from_minor: number | null;
    to_minor: number | null;
    base_minor: number | null;
    discount_depth_bps: number;
    has_discount: number;
    available_for_sale: number;
    has_customer_options: number;
    availability_band: string;
};

async function liveBuyerState(): Promise<BuyerStateRow[]> {
    const pricing = buildBuyerCatalogPricingProjection(db);
    const rows = await db.select({
        id: products.id,
        isActive: sql<number>`${products.isActive}`,
        deletedAt: sql<number | null>`${products.deletedAt}`,
        categoryId: products.categoryId,
        brandId: products.brandId,
        createdAt: sql<number>`${products.createdAt}`,
        eligible: sql<number>`CASE WHEN ${publicProductHasBuyerResolvableSku()} THEN 1 ELSE 0 END`,
        skuId: pricing.skuId,
        from: pricing.effectivePriceMinor,
        to: pricing.maxBuyerPriceMinor,
        base: pricing.basePriceMinor,
        hasDiscount: pricing.hasDiscount,
        availableForSale: pricing.availableForSale,
        hasCustomerOptions: pricing.hasCustomerOptions,
    }).from(products).leftJoin(pricing, eq(pricing.productId, products.id)).all();
    const skus = new Map((sqlite.prepare(
        "SELECT id, stock, reserved_stock, track_inventory, low_stock_threshold FROM product_variants",
    ).all() as Array<{ id: string; stock: number; reserved_stock: number; track_inventory: number; low_stock_threshold: number | null }>)
        .map((row) => [row.id, row]));
    return rows.map((row) => {
        const priced = row.skuId !== null;
        const from = priced ? Number(row.from) : null;
        const base = priced ? Math.max(Number(row.base), from!) : null;
        const card = row.skuId ? skus.get(row.skuId) : undefined;
        return {
            product_id: row.id,
            is_public: row.isActive === 1 && row.deletedAt === null && priced && row.eligible === 1 ? 1 : 0,
            category_id: row.categoryId,
            brand_id: row.brandId,
            product_created_at: Number(row.createdAt),
            sku_id: row.skuId,
            from_minor: from,
            to_minor: priced ? Math.max(Number(row.to ?? from), from!) : null,
            base_minor: base,
            discount_depth_bps: priced && base! > 0 && base! > from!
                ? Math.min(Math.trunc(((base! - from!) * 10_000) / base!), 10_000)
                : 0,
            has_discount: Number(row.hasDiscount ?? 0),
            available_for_sale: Number(row.availableForSale ?? 0),
            has_customer_options: Number(row.hasCustomerOptions ?? 0),
            availability_band: card
                ? resolveBuyerAvailabilityBand({
                    stock: card.stock,
                    reservedStock: card.reserved_stock,
                    trackInventory: card.track_inventory === 1,
                    lowStockThreshold: card.low_stock_threshold,
                })
                : "out_of_stock",
        };
    }).sort((a, b) => byKey(a.product_id, b.product_id));
}

function storedBuyerState(): BuyerStateRow[] {
    return (sqlite.prepare("SELECT * FROM product_buyer_state ORDER BY product_id").all() as Array<BuyerStateRow & { refreshed_at: number }>)
        .map(({ refreshed_at: _refreshedAt, ...row }) => ({ ...row }))
        .sort((a, b) => byKey(a.product_id, b.product_id));
}

type FacetRow = {
    owner_id: string;
    product_id: string;
    variant_id: string | null;
    facet_kind: string;
    facet_key: string;
    value_key: string;
    value_label: string;
    value_number: number | null;
    sort_order: number;
};

function liveFacets(): FacetRow[] {
    const rows: FacetRow[] = [];
    const attributes = sqlite.prepare(`
        SELECT pav.product_id, pav.value, pav.value_id, pav.value_number, pa.id AS attribute_id, pa.value_type, av.sort_order
        FROM product_attribute_values pav
        JOIN product_attributes pa ON pa.id = pav.attribute_id AND pa.deleted_at IS NULL
        LEFT JOIN attribute_values av ON av.id = pav.value_id
    `).all() as Array<{ product_id: string; value: string; value_id: string | null; value_number: number | null; attribute_id: string; value_type: TypedAttributeValue["type"]; sort_order: number | null }>;
    for (const row of attributes) {
        const typed = { type: row.value_type, value: row.value, valueId: row.value_id, valueNumber: row.value_number } as TypedAttributeValue;
        const key = attributeFacetValueKey(typed).slice(0, 200);
        if (!key) continue;
        rows.push({
            owner_id: row.product_id,
            product_id: row.product_id,
            variant_id: null,
            facet_kind: "attribute",
            facet_key: row.attribute_id,
            value_key: key,
            value_label: row.value.trim().slice(0, 200) || key,
            value_number: row.value_type === "number" || row.value_type === "boolean" ? row.value_number : null,
            sort_order: row.sort_order ?? 0,
        });
    }
    const options = sqlite.prepare(`
        SELECT sku.id AS sku_id, sku.product_id, axis.name AS axis_name, value.value, value.position
        FROM product_variants sku
        JOIN product_variant_option_values assignment ON assignment.variant_id = sku.id
        JOIN product_option_definitions axis ON axis.id = assignment.option_definition_id AND axis.deleted_at IS NULL
        JOIN product_option_values value ON value.id = assignment.option_value_id AND value.deleted_at IS NULL
        WHERE sku.deleted_at IS NULL AND sku.id <> 'default'
    `).all() as Array<{ sku_id: string; product_id: string; axis_name: string; value: string; position: number }>;
    for (const row of options) {
        rows.push({
            owner_id: row.sku_id,
            product_id: row.product_id,
            variant_id: row.sku_id,
            facet_kind: "option",
            facet_key: optionFacetKey(row.axis_name),
            value_key: normalizeProductOptionIdentity(row.value),
            value_label: row.value.trim(),
            value_number: null,
            sort_order: row.position,
        });
    }
    return rows.sort((a, b) => byKey(`${a.owner_id}|${a.facet_key}`, `${b.owner_id}|${b.facet_key}`));
}

function storedFacets(): FacetRow[] {
    return (sqlite.prepare("SELECT * FROM product_facet_values").all() as FacetRow[])
        .map((row) => ({ ...row }))
        .sort((a, b) => byKey(`${a.owner_id}|${a.facet_key}`, `${b.owner_id}|${b.facet_key}`));
}

async function expectNoDrift(step: string) {
    expect(storedBuyerState(), `buyer state after ${step}`).toEqual(await liveBuyerState());
    expect(storedFacets(), `facets after ${step}`).toEqual(liveFacets());
}

// ── The walk ─────────────────────────────────────────────────────────────

function prng(seed: number) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    return {
        next,
        int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
        pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
        chance: (p: number) => next() < p,
    };
}

const baseInput = {
    description: "A product for the projection drift walk.",
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    excludeFromProductFeed: false,
    productCondition: "new" as const,
    media: [],
    additionalInfo: [],
};

type Rng = ReturnType<typeof prng>;

async function createRandomProduct(rng: Rng, index: number) {
    const attributes = [
        ...(rng.chance(0.7) ? [{ attributeId: "attr_material", value: rng.pick(["Cotton", " Linen ", "WOOL"]) }] : []),
        ...(rng.chance(0.4) ? [{ attributeId: "attr_fit", value: rng.pick(["Slim", "Regular"]) }] : []),
    ];
    const common = {
        ...baseInput,
        name: `Walk product ${index}`,
        categoryId: rng.pick(["cat_a", "cat_b", null]),
        brandId: rng.pick(["brd_walton01", "brd_minister1", null, undefined]),
        isActive: rng.chance(0.85),
        discountPercentage: rng.pick([0, 0, 10, 25]),
        attributes,
    };
    if (rng.chance(0.5)) {
        const tracked = rng.chance(0.8);
        return createProduct(db, createProductSchema.parse({
            ...common,
            price: rng.pick([150, 300, 999]),
            defaultSku: { sku: `WALK-${index}`, trackInventory: tracked, stock: tracked ? rng.int(0, 6) : 0 },
        }));
    }
    const sizes = rng.chance(0.5) ? ["S", "M"] : ["S", "M", "L"];
    const colours = rng.chance(0.5) ? ["Red"] : ["Red", "Blue"];
    const options = [
        { id: "draft_size", name: "Size", standardMapping: "size", values: sizes.map((value) => ({ id: `draft_size_${value}`, value })) },
        { id: "draft_colour", name: rng.pick(["Colour", "Shade"]), standardMapping: "color", values: colours.map((value) => ({ id: `draft_colour_${value}`, value })) },
    ];
    const variants = sizes.flatMap((size) => colours.map((colour) => {
        const tracked = rng.chance(0.8);
        const discounted = rng.chance(0.3);
        return {
            id: `draft_${size}_${colour}`,
            selectedOptionValueIds: [`draft_size_${size}`, `draft_colour_${colour}`],
            imageId: null,
            sku: `WALK-${index}-${size}-${colour}`,
            price: rng.pick([200, 250, 400]),
            stock: tracked ? rng.int(0, 4) : 0,
            trackInventory: tracked,
            weight: null,
            barcode: null,
            barcodeType: null,
            discountType: "percentage" as const,
            discountPercentage: discounted ? 20 : null,
            discountAmount: null,
        };
    }));
    return createProduct(db, createProductSchema.parse({
        ...common,
        price: Math.min(...variants.map((variant) => variant.price)),
        optionMatrix: { options, variants },
    }));
}

function productRow(id: string) {
    return sqlite.prepare("SELECT aggregate_revision AS revision, deleted_at AS deletedAt FROM products WHERE id = ?")
        .get(id) as { revision: number; deletedAt: number | null } | undefined;
}

function liveSkus(productId?: string) {
    return sqlite.prepare(`
        SELECT id, product_id AS productId, stock, reserved_stock AS reserved, stock_version AS stockVersion, track_inventory AS tracked,
               price_minor AS priceMinor, is_default AS isDefault
        FROM product_variants WHERE deleted_at IS NULL ${productId ? "AND product_id = ?" : ""}
    `).all(...(productId ? [productId] : [])) as Array<{
        id: string; productId: string; stock: number; reserved: number; stockVersion: number; tracked: number; priceMinor: number; isDefault: number;
    }>;
}

async function checkoutOne(rng: Rng): Promise<string | null> {
    const candidates = sqlite.prepare(`
        SELECT s.product_id AS productId, s.sku_id AS variantId
        FROM product_buyer_state s WHERE s.is_public = 1 AND s.available_for_sale = 1
    `).all() as Array<{ productId: string; variantId: string }>;
    if (candidates.length === 0) return null;
    const chosen = rng.pick(candidates);
    let price = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const data: CreateStorefrontOrderInput = {
            checkoutRequestId: `request_${crypto.randomUUID()}`,
            expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
            customerName: "Walk Buyer",
            customerPhone: "+8801712345678",
            customerEmail: null,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            discountCodes: [],
            shippingCharge: 0,
            shippingMethodId: "m_ship",
            paymentMethod: "cod",
            inventoryPool: "regular",
            items: [{ productId: chosen.productId, variantId: chosen.variantId, quantity: 1, price }],
        };
        try {
            const authority = await loadStorefrontCheckoutAuthority(db, {
                items: data.items,
                inventoryPool: data.inventoryPool,
                city: data.city,
                zone: data.zone,
                area: data.area,
                shippingMethodId: data.shippingMethodId,
                customerPhone: data.customerPhone,
            });
            const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
            const result = await createStorefrontOrder(
                db, data, "https://shop.example.com/api/v1/orders",
                { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
                authority.cartValidation, authority.deliveryPreflight, undefined,
                { code: "BDT", decimalPlaces: 2 },
                createTrustedStorefrontCheckoutPolicySnapshot({
                    partialPaymentEnabled: false,
                    authorityRevision: authority.authorityRevision,
                    orderCreatedNotificationEnabled: false,
                    metaPurchaseEnabled: false,
                }),
                authority.taxAuthority,
            );
            await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
            return result.orderId;
        } catch (error) {
            const issue = (error as { details?: { itemIssues?: Array<{ code: string; currentPrice?: number }> } })
                .details?.itemIssues?.[0];
            if (issue?.code === "PRICE_CHANGED" && typeof issue.currentPrice === "number") {
                price = issue.currentPrice;
                continue;
            }
            if (error instanceof AppError) return null;
            throw error;
        }
    }
    return null;
}

describe("catalogue projection drift", () => {
    it("stays equal to its sources through a random walk of product, SKU, stock and checkout writes", async () => {
        const rng = prng(20260925);
        const productIds: string[] = [];
        const orders: Array<{ id: string; state: "reserved" | "deducted" | "closed" }> = [];
        const counts = new Map<string, number>();
        const refused = new Map<string, number>();
        const steps: Array<[string, () => Promise<unknown>]> = [
            ["create", async () => {
                const created = await createRandomProduct(rng, productIds.length);
                productIds.push(created.id);
            }],
            ["base section", async () => {
                const id = rng.pick(productIds);
                const row = productRow(id);
                if (!row || row.deletedAt !== null) return;
                await updateProductSemanticSection(db, id, {
                    section: "base",
                    expectedAggregateRevision: row.revision,
                    patch: rng.pick([
                        { isActive: rng.chance(0.5) },
                        { categoryId: rng.pick(["cat_a", "cat_b", null]) },
                        { brandId: rng.pick(["brd_walton01", "brd_minister1", null]) },
                        { discountPercentage: rng.pick([0, 15]), discountType: "percentage" as const },
                        { price: rng.pick([180, 420]) },
                    ]),
                });
            }],
            ["full update", async () => {
                const id = rng.pick(productIds);
                const details = await getProductDetails(db, id);
                if (!details || details.deletedAt) return;
                await updateProduct(db, id, updateProductSchema.parse({
                    ...baseInput,
                    id,
                    name: details.name,
                    slug: details.slug,
                    price: details.price,
                    categoryId: details.categoryId,
                    isActive: details.isActive,
                    discountPercentage: rng.pick([0, 5]),
                    attributes: rng.chance(0.5) ? [] : [{ attributeId: "attr_material", value: rng.pick(["Silk", "Cotton"]) }],
                    // Omitted keeps the brand; a value or null replaces it.
                    ...(rng.chance(0.5) ? { brandId: rng.pick(["brd_walton01", null]) } : {}),
                    expectedAggregateRevision: details.aggregateRevision,
                }));
            }],
            ["trash or restore", async () => {
                const id = rng.pick(productIds);
                const row = productRow(id);
                if (!row) return;
                if (row.deletedAt === null) await deleteProduct(db, id, row.revision);
                else await restoreProduct(db, id, row.revision);
            }],
            ["bulk status", async () => {
                const ids = [...new Set([rng.pick(productIds), rng.pick(productIds)])];
                const claims = ids.flatMap((id) => {
                    const row = productRow(id);
                    return row && row.deletedAt === null ? [{ id, expectedAggregateRevision: row.revision }] : [];
                });
                if (claims.length > 0) await bulkUpdateProducts(db, claims, { isActive: rng.chance(0.6) });
            }],
            ["duplicate", async () => {
                const id = rng.pick(productIds);
                const row = productRow(id);
                if (!row || row.deletedAt !== null) return;
                // duplicateProduct refuses (with a raw ZodError, a pre-existing gap) a
                // source whose option value no live SKU uses any more.
                const copy = await duplicateProduct(db, id, `Copy ${productIds.length}`)
                    .catch((error: unknown) => {
                        if (error instanceof Error && error.name === "ZodError") return null;
                        throw error;
                    });
                if (copy) productIds.push(copy.id);
            }],
            ["variant price", async () => {
                const sku = rng.pick(liveSkus().filter((row) => row.isDefault === 0));
                if (!sku) return;
                const details = await getProductDetails(db, sku.productId);
                const variant = details?.variants.find((each) => each.id === sku.id);
                if (!details || details.deletedAt || !variant) return;
                await updateVariant(db, sku.productId, sku.id, {
                    selectedOptionValueIds: variant.selectedOptions.map((option) => option.optionValueId),
                    imageId: null,
                    weight: null,
                    sku: variant.sku,
                    price: rng.pick([150, 260, 380]),
                    discountType: "percentage",
                    discountPercentage: rng.pick([null, 30]),
                    discountAmount: null,
                    expectedAggregateRevision: details.aggregateRevision,
                } as never);
            }],
            ["delete variant", async () => {
                const sku = rng.pick(liveSkus().filter((row) => row.isDefault === 0));
                if (!sku || liveSkus(sku.productId).length < 2) return;
                const row = productRow(sku.productId);
                if (!row || row.deletedAt !== null) return;
                await deleteVariant(db, sku.productId, sku.id, row.revision);
            }],
            ["adjust stock", async () => {
                const sku = rng.pick(liveSkus().filter((row) => row.tracked === 1));
                if (!sku) return;
                const delta = rng.pick([-2, -1, 1, 3]);
                if (sku.stock - sku.reserved + delta < 0) return;
                await adjustStock(db, sku.id, delta, `walk_adjust_${crypto.randomUUID()}`);
            }],
            ["stocktake", async () => {
                const sku = rng.pick(liveSkus().filter((row) => row.tracked === 1));
                if (!sku) return;
                await setStock(db, sku.id, Math.max(sku.reserved, rng.int(0, 5)), `walk_set_${crypto.randomUUID()}`);
            }],
            ["alert level", async () => {
                const sku = rng.pick(liveSkus().filter((row) => row.tracked === 1));
                if (!sku) return;
                await setLowStockThreshold(db, sku.id, rng.pick([null, 1, 3]));
            }],
            ["checkout", async () => {
                const orderId = await checkoutOne(rng);
                if (orderId) orders.push({ id: orderId, state: "reserved" });
            }],
            ["order transition", async () => {
                const order = rng.pick(orders.filter((each) => each.state !== "closed"));
                if (!order) return;
                if (order.state === "reserved" && rng.chance(0.5)) {
                    await applyInventoryForStatusChange(db, order.id, "shipped");
                    order.state = "deducted";
                } else {
                    await applyInventoryForStatusChange(db, order.id, "cancelled");
                    order.state = "closed";
                }
            }],
            ["expire reservations", async () => {
                await releaseExpiredReservations(db, -60, { limit: 5 });
            }],
        ];

        for (let index = 0; index < 4; index += 1) await steps[0]![1]();
        await expectNoDrift("seed products");
        for (let step = 0; step < 160; step += 1) {
            const [name, run] = rng.chance(0.15) ? steps[0]! : rng.pick(steps);
            try {
                await run();
                counts.set(name, (counts.get(name) ?? 0) + 1);
            } catch (error) {
                // A refused write (validation, revision, stock) must leave no drift either.
                if (!(error instanceof AppError)) throw error;
                refused.set(name, (refused.get(name) ?? 0) + 1);
            }
            await expectNoDrift(`step ${step} (${name})`);
        }
        // Every kind of write committed at least once.
        console.info("[drift walk] committed", Object.fromEntries(counts), "refused", Object.fromEntries(refused), "orders", orders.length);
        expect([...counts.keys()].sort()).toEqual(steps.map(([name]) => name).sort());
        expect(storedBuyerState().some((row) => row.is_public === 1)).toBe(true);
        expect(storedFacets().some((row) => row.facet_kind === "option")).toBe(true);
    });

    it("writes a live brand through the product editor into the buyer state", async () => {
        const created = await createRandomProduct(prng(3), 0);
        const revision = () => productRow(created.id)!.revision;
        const stateBrand = () => (sqlite.prepare("SELECT brand_id AS brandId FROM product_buyer_state WHERE product_id = ?")
            .get(created.id) as { brandId: string | null }).brandId;

        await updateProductSemanticSection(db, created.id, {
            section: "base", expectedAggregateRevision: revision(), patch: { brandId: "brd_walton01" },
        });
        expect(stateBrand()).toBe("brd_walton01");
        // A trashed brand is refused; nothing changes.
        await expect(updateProductSemanticSection(db, created.id, {
            section: "base", expectedAggregateRevision: revision(), patch: { brandId: "brd_trashed1" },
        })).rejects.toMatchObject({ details: { field: "brandId" } });
        expect(stateBrand()).toBe("brd_walton01");
        // The full editor keeps an omitted brand and clears it on null.
        const details = (await getProductDetails(db, created.id))!;
        expect(details.brandId).toBe("brd_walton01");
        const full = {
            ...baseInput, id: created.id, name: details.name, slug: details.slug, price: details.price,
            categoryId: details.categoryId, isActive: details.isActive, attributes: [],
        };
        await updateProduct(db, created.id, updateProductSchema.parse({ ...full, expectedAggregateRevision: revision() }));
        expect(stateBrand()).toBe("brd_walton01");
        await updateProduct(db, created.id, updateProductSchema.parse({ ...full, brandId: null, expectedAggregateRevision: revision() }));
        expect(stateBrand()).toBeNull();
        await expect(createProduct(db, createProductSchema.parse({
            ...baseInput, name: "Branded", categoryId: null, isActive: true, price: 100, attributes: [], brandId: "brd_missing1",
        }))).rejects.toMatchObject({ details: { field: "brandId" } });
        await expectNoDrift("brand writes");
    });

    it("rebuilds from nothing and heals rows a write path never touched", async () => {
        for (let index = 0; index < 5; index += 1) await createRandomProduct(prng(index + 1), index);
        sqlite.exec("DELETE FROM product_buyer_state; DELETE FROM product_facet_values;");
        // Drift a raw write can cause: a price edited outside the services.
        sqlite.exec("UPDATE product_variants SET price_minor = price_minor + 100");
        expect(storedBuyerState()).toEqual([]);

        let cursor: string | null = null;
        let calls = 0;
        for (;;) {
            const chunk = await rebuildCatalogProjections(db, { afterProductId: cursor, limit: 2 });
            calls += 1;
            if (chunk.done) break;
            cursor = chunk.nextAfterProductId;
        }
        expect(calls).toBe(3);
        await expectNoDrift("rebuild");
    });

    it("keys typed attribute values like the shared rules and never fails the write", async () => {
        const created = await createRandomProduct(prng(7), 0);
        sqlite.exec(`
            INSERT INTO product_attributes (id, name, slug, filterable, value_type, unit, facet_display) VALUES
                ('attr_display', 'Display', 'display', 1, 'number', 'in', 'range'),
                ('attr_wifi', 'Wi-Fi', 'wifi', 1, 'boolean', NULL, 'checkbox'),
                ('attr_colour', 'Colour', 'colour', 1, 'enum', NULL, 'swatch'),
                ('attr_gone', 'Gone', 'gone', 1, 'text', NULL, 'checkbox');
            UPDATE product_attributes SET deleted_at = 1 WHERE id = 'attr_gone';
            INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order, swatch_hex)
            VALUES ('atv_midnight_1', 'attr_colour', 'Midnight', 'midnight', 4, '#101820');
            DELETE FROM product_attribute_values WHERE product_id = '${created.id}';
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_id, value_number) VALUES
                ('pav_1', '${created.id}', 'attr_display', '15.60 in', NULL, 15.6),
                ('pav_2', '${created.id}', 'attr_wifi', 'Yes', NULL, 1),
                ('pav_3', '${created.id}', 'attr_colour', 'Midnight', 'atv_midnight_1', NULL),
                ('pav_4', '${created.id}', 'attr_gone', 'Anything', NULL, NULL),
                ('pav_5', '${created.id}', 'attr_material', '${"x".repeat(250)}', NULL, NULL);
        `);
        await safeBatch(db, catalogProjectionRefreshStatements(db, [created.id]) as never);

        const keys = storedFacets().filter((row) => row.facet_kind === "attribute")
            .map((row) => [row.facet_key, row.value_key, row.value_number, row.sort_order]);
        expect(keys).toEqual(expect.arrayContaining([
            ["attr_display", "15.6", 15.6, 0],
            ["attr_wifi", "1", 1, 0],
            ["attr_colour", "atv_midnight_1", null, 4],
            ["attr_material", "x".repeat(200), null, 0],
        ]));
        expect(keys.some(([key]) => key === "attr_gone")).toBe(false);
        await expectNoDrift("typed attributes");
    });
});
