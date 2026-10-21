// Sales channels (docs/MARKETS-DESIGN.md D6, step 5) end to end over the
// real schema: a product unpublished from a channel is absent from it (the
// online store's page, listings and search; a feed's rows; the agents
// channel's UCP rows), an inactive channel shows nothing, checkout refuses a
// SKU its channel does not publish, and a channel sells only the on-hand of
// its linked locations (cart validation, reservation guard, product page),
// while a store that never unlinked a location reads exactly as before.
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    AGENTS_CHANNEL_ID,
    GOOGLE_CHANNEL_ID,
    META_CHANNEL_ID,
    ONLINE_STORE_CHANNEL_ID,
} from "@scalius/shared/sales-channels";

import { rebuildCatalogProjections } from "../products";
import { getStorefrontFeedProducts, getStorefrontProductBySlug, getStorefrontProducts } from "../catalog";
import { validateStorefrontCartItems } from "../checkout";
import { prepareStockReservationBatch } from "../inventory";
import {
    getSalesChannel,
    listChannelProducts,
    listSalesChannels,
    readProductChannels,
    resolveStaffOrderSalesChannel,
    setProductChannels,
    setProductPublications,
    updateSalesChannel,
} from "./sales-channels.service";

let sqlite: DatabaseSync;
let db: Database;

function insertProduct(id: string, createdAt: number, stock: number): void {
    sqlite.prepare(
        `INSERT INTO products (id, name, description, price_minor, slug, is_active, created_at, updated_at)
         VALUES (?, ?, '', 100000, ?, 1, ?, ?)`,
    ).run(id, `Product ${id}`, id.replace(/_/g, "-"), createdAt, createdAt);
    sqlite.prepare(
        `INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, status)
         VALUES (?, ?, 'image', ?, 1, 'image/jpeg', ?, 'ready')`,
    ).run(`media_${id}`, `${id}.jpg`, `products/${id}.jpg`, id);
    sqlite.prepare(
        `INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order) VALUES (?, ?, ?, ?, 1, 0)`,
    ).run(`pmed_${id}`, id, `media_${id}`, id);
    sqlite.prepare(
        `INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
         VALUES (?, ?, ?, 100000, ?, 1, 1)`,
    ).run(`var_${id}`, id, `SKU-${id}`, stock);
}

async function rebuild(): Promise<void> {
    let after: string | null = null;
    for (;;) {
        const chunk: { done: boolean; nextAfterProductId: string | null } = await rebuildCatalogProjections(db, { afterProductId: after });
        if (chunk.done) return;
        after = chunk.nextAfterProductId;
    }
}

const feedIds = async (channel?: typeof GOOGLE_CHANNEL_ID | typeof META_CHANNEL_ID | typeof AGENTS_CHANNEL_ID) =>
    (await getStorefrontFeedProducts(db, { limit: 50, ...(channel ? { channel } : {}) })).products.map((product) => product.id);
const listingIds = async () => (await getStorefrontProducts(db, { limit: 50 })).products.map((product) => product.id);

beforeEach(async () => {
    ({ sqlite, db } = createSqliteD1Database());
    insertProduct("prod_tee", 1, 5);
    insertProduct("prod_cap", 2, 5);
    await rebuild();
});

afterEach(() => sqlite.close());

describe("publications", () => {
    it("publishes a new product to every channel and lists them", async () => {
        expect(await readProductChannels(db, "prod_tee")).toEqual([AGENTS_CHANNEL_ID, GOOGLE_CHANNEL_ID, META_CHANNEL_ID, ONLINE_STORE_CHANNEL_ID]);
        const channels = await listSalesChannels(db);
        expect(channels.map((channel) => [channel.id, channel.publishedProducts, channel.locationIds])).toEqual([
            [ONLINE_STORE_CHANNEL_ID, 2, ["loc_default"]],
            [GOOGLE_CHANNEL_ID, 2, ["loc_default"]],
            [META_CHANNEL_ID, 2, ["loc_default"]],
            [AGENTS_CHANNEL_ID, 2, ["loc_default"]],
        ]);
    });

    it("counts the products a channel's link lists: trashed products are left out", async () => {
        sqlite.prepare("UPDATE products SET deleted_at = 1 WHERE id = 'prod_cap'").run();
        const counts = (await listSalesChannels(db)).map((channel) => [channel.id, channel.publishedProducts]);
        expect(counts).toEqual([
            [ONLINE_STORE_CHANNEL_ID, 1],
            [GOOGLE_CHANNEL_ID, 1],
            [META_CHANNEL_ID, 1],
            [AGENTS_CHANNEL_ID, 1],
        ]);
        sqlite.prepare("UPDATE products SET deleted_at = NULL WHERE id = 'prod_cap'").run();
        expect((await listSalesChannels(db))[0]!.publishedProducts).toBe(2);
    });

    it("takes a product unpublished from the online store off its page, listings and every feed", async () => {
        await setProductPublications(db, { productIds: ["prod_cap"], channelIds: [ONLINE_STORE_CHANNEL_ID], action: "unpublish" });
        expect(await getStorefrontProductBySlug(db, "prod-cap")).toBeNull();
        expect(await listingIds()).toEqual(["prod_tee"]);
        // A feed row links to its product page, so it needs the online store too.
        expect(await feedIds()).toEqual(["prod_tee"]);
        expect(await feedIds(AGENTS_CHANNEL_ID)).toEqual(["prod_tee"]);

        await setProductPublications(db, { productIds: ["prod_cap"], channelIds: [ONLINE_STORE_CHANNEL_ID], action: "publish" });
        expect(await getStorefrontProductBySlug(db, "prod-cap")).not.toBeNull();
        expect(await listingIds()).toEqual(["prod_cap", "prod_tee"]);
    });

    it("keeps a product on the store while it leaves one feed", async () => {
        await setProductChannels(db, "prod_cap", [ONLINE_STORE_CHANNEL_ID, META_CHANNEL_ID]);
        expect(await readProductChannels(db, "prod_cap")).toEqual([META_CHANNEL_ID, ONLINE_STORE_CHANNEL_ID]);
        expect(await listingIds()).toEqual(["prod_cap", "prod_tee"]);
        expect(await feedIds(GOOGLE_CHANNEL_ID)).toEqual(["prod_tee"]);
        expect(await feedIds(META_CHANNEL_ID)).toEqual(["prod_cap", "prod_tee"]);
        expect(await feedIds(AGENTS_CHANNEL_ID)).toEqual(["prod_tee"]);
        expect(await listChannelProducts(db, META_CHANNEL_ID, { limit: 1 })).toEqual({ productIds: ["prod_cap"], nextAfter: "prod_cap" });
        expect(await listChannelProducts(db, META_CHANNEL_ID, { after: "prod_cap" })).toEqual({ productIds: ["prod_tee"], nextAfter: null });
    });

    it("lists nothing on an inactive channel, and never switches the online store off", async () => {
        await updateSalesChannel(db, META_CHANNEL_ID, { status: "inactive" });
        expect(await feedIds(META_CHANNEL_ID)).toEqual([]);
        expect(await feedIds(GOOGLE_CHANNEL_ID)).toEqual(["prod_cap", "prod_tee"]);
        await expect(updateSalesChannel(db, ONLINE_STORE_CHANNEL_ID, { status: "inactive" })).rejects.toThrow(/always on/);
        await expect(updateSalesChannel(db, GOOGLE_CHANNEL_ID, { locationIds: [] })).rejects.toThrow(/at least one location/);
    });

    it("refuses at checkout a SKU its sales channel does not publish", async () => {
        await setProductPublications(db, { productIds: ["prod_cap"], channelIds: [AGENTS_CHANNEL_ID], action: "unpublish" });
        const cart = [{ productId: "prod_cap", variantId: "var_prod_cap", quantity: 1 }];
        expect((await validateStorefrontCartItems(db, cart)).valid).toBe(true);
        const agent = await validateStorefrontCartItems(db, cart, { salesChannelId: AGENTS_CHANNEL_ID });
        expect(agent.valid).toBe(false);
        expect(agent.issues[0]).toMatchObject({ code: "product_unavailable", productId: "prod_cap" });
    });

    it("names a staff order's channel: the online store by default, else an active channel", async () => {
        expect(await resolveStaffOrderSalesChannel(db, null)).toBe(ONLINE_STORE_CHANNEL_ID);
        expect(await resolveStaffOrderSalesChannel(db, META_CHANNEL_ID)).toBe(META_CHANNEL_ID);
        await updateSalesChannel(db, META_CHANNEL_ID, { status: "inactive" });
        await expect(resolveStaffOrderSalesChannel(db, META_CHANNEL_ID)).rejects.toThrow(/off or no longer exists/);
    });
});

describe("channel stock locations", () => {
    beforeEach(() => {
        // Two of the tee's five units sit at a second location (levels add up to stock).
        sqlite.exec(`
            INSERT INTO inventory_locations (id, name, code, country_code, is_default, status, position) VALUES ('loc_dhk', 'Dhaka shop', 'DHK', 'BD', 0, 'active', 1);
            UPDATE inventory_levels SET on_hand = 3 WHERE variant_id = 'var_prod_tee' AND location_id = 'loc_default';
            INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ('var_prod_tee', 'loc_dhk', 2);
        `);
    });

    it("links a new location to every channel, so every channel sells the whole stock", async () => {
        expect((await getSalesChannel(db, ONLINE_STORE_CHANNEL_ID)).locationIds).toEqual(["loc_default", "loc_dhk"]);
        const cart = [{ productId: "prod_tee", variantId: "var_prod_tee", quantity: 5 }];
        expect((await validateStorefrontCartItems(db, cart)).valid).toBe(true);
    });

    it("sells only the on-hand of the channel's linked locations, less every reservation", async () => {
        const { locationsChanged } = await updateSalesChannel(db, ONLINE_STORE_CHANNEL_ID, { locationIds: ["loc_default"] });
        expect(locationsChanged).toBe(true);
        sqlite.exec("UPDATE product_variants SET reserved_stock = 1 WHERE id = 'var_prod_tee'");

        const tooMany = await validateStorefrontCartItems(db, [{ productId: "prod_tee", variantId: "var_prod_tee", quantity: 3 }]);
        expect(tooMany.issues[0]).toMatchObject({ code: "quantity_unavailable", availableQuantity: 2 });
        // Google still sells both locations.
        const google = await validateStorefrontCartItems(db, [{ productId: "prod_tee", variantId: "var_prod_tee", quantity: 4 }], { salesChannelId: GOOGLE_CHANNEL_ID });
        expect(google.valid).toBe(true);

        // The reservation guard holds the same line in the write itself.
        const refused = await prepareStockReservationBatch(db, [{ variantId: "var_prod_tee", quantity: 3, orderId: "ord_1" }], "regular", { salesChannelId: ONLINE_STORE_CHANNEL_ID });
        await expect(db.batch(refused.statements as never)).rejects.toThrow();
        const allowed = await prepareStockReservationBatch(db, [{ variantId: "var_prod_tee", quantity: 2, orderId: "ord_2" }], "regular", { salesChannelId: ONLINE_STORE_CHANNEL_ID });
        await db.batch(allowed.statements as never);
        expect(sqlite.prepare("SELECT reserved_stock AS reserved FROM product_variants WHERE id = 'var_prod_tee'").get()).toEqual({ reserved: 3 });
    });

    it("bands the product page and the stored buyer state on the linked locations", async () => {
        await updateSalesChannel(db, ONLINE_STORE_CHANNEL_ID, { locationIds: ["loc_dhk"] });
        await rebuild();
        sqlite.exec("UPDATE product_variants SET reserved_stock = 2 WHERE id = 'var_prod_tee'");
        await rebuild();
        const page = await getStorefrontProductBySlug(db, "prod-tee");
        expect(page?.variants?.[0]).toMatchObject({ availabilityBand: "out_of_stock" });
        expect(sqlite.prepare("SELECT availability_band AS band FROM product_buyer_state WHERE product_id = 'prod_tee'").get())
            .toEqual({ band: "out_of_stock" });
        // The Google feed sells both locations: three units left.
        const feed = await getStorefrontFeedProducts(db, { ids: "prod_tee", limit: 10, channel: GOOGLE_CHANNEL_ID });
        expect(feed.products[0]).toMatchObject({ availableForSale: true });
    });
});
