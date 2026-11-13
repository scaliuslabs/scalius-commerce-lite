// Test-only: a randomised catalogue for the recommendation ranking
// (recommendations-ranking.oracle.d1.test.ts and the batch timing harness):
// hidden, inactive and draft-category products, unpriced and out-of-stock
// SKUs, manual and dynamic collections (inactive ones too), shared attribute
// values, old, cancelled and duplicate orders, buyers by phone and email, and
// ties in time, score and price.
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { rebuildCatalogProjections } from "../products";

const NOW = Math.floor(Date.now() / 1000);

export function rng(seed: number) {
    let state = seed;
    // High bits: an LCG's low bits repeat with a short period.
    return (n: number) => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return Math.floor(state / 65_536) % n; };
}

export function seedRankingCatalogue(sqlite: DatabaseSync, seed: number, size: number, options: { idLength?: number; categories?: number; orders?: number } = {}): string[] {
    const random = rng(seed);
    const categories = ["cat_a", "cat_b", "cat_c", "cat_draft", ...Array.from({ length: options.categories ?? 0 }, (_, index) => `cat_x${index}`)];
    for (const id of categories) {
        sqlite.prepare("INSERT INTO categories (id, name, slug, status) VALUES (?, ?, ?, ?)").run(id, id, id, id === "cat_draft" ? "draft" : "published");
    }
    const ids: string[] = [];
    for (let index = 0; index < size; index += 1) {
        const id = `p_${String(index).padStart(options.idLength ? options.idLength - 2 : 3, "0")}`;
        ids.push(id);
        // Ties: a few creation times and prices only.
        const createdAt = NOW - 86_400 * (1 + random(4));
        const price = [0, 50_000, 100_000, 120_000, 300_000][random(5)]!;
        const category = random(6) === 0 ? null : categories[random(categories.length)]!;
        sqlite.prepare(`INSERT INTO products (id, name, description, price_minor, category_id, slug, is_active, created_at, updated_at)
            VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`).run(id, id, price, category, id, random(8) === 0 ? 0 : 1, createdAt, createdAt);
        sqlite.prepare(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
            VALUES (?, ?, ?, ?, ?, 1, 1)`).run(`var_${id}`, id, `SKU-${id}`, price, random(7) === 0 ? 0 : 5);
        sqlite.prepare(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, status)
            VALUES (?, ?, 'image', ?, 1, 'image/jpeg', 'Photo', 'ready')`).run(`media_${id}_0`, `media_${id}_0`, `products/media_${id}_0.jpg`);
        sqlite.prepare("INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES (?, ?, ?, 1, 0)")
            .run(`pmed_${id}_0`, id, `media_${id}_0`);
        for (const attribute of ["colour", "fabric"]) {
            if (random(2) === 0) continue;
            sqlite.prepare("INSERT OR IGNORE INTO product_attributes (id, name, slug, filterable) VALUES (?, ?, ?, 1)").run(attribute, attribute, attribute);
            sqlite.prepare("INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES (?, ?, ?, ?)")
                .run(`pav_${id}_${attribute}`, id, attribute, ["red", "blue", "cotton", "linen"][random(4)]!);
        }
    }
    if (size > 0) {
        const pick = () => ids[random(ids.length)]!;
        const collection = (id: string, config: Record<string, unknown>, active: boolean) => sqlite.prepare(
            "INSERT INTO collections (id, name, presentation, config, is_active) VALUES (?, ?, 'grid', ?, ?)",
        ).run(id, id, JSON.stringify(config), active ? 1 : 0);
        collection("col_manual", { source: "manual", productIds: [pick(), pick(), pick(), pick()] }, true);
        collection("col_dynamic", { source: "dynamic", categoryIds: ["cat_a", "cat_b", "cat_draft"] }, true);
        if (options.categories) {
            // Every category in one rule (a pool past RELATED_CANDIDATE_LIMIT), and many manual lists.
            collection("col_every", { source: "dynamic", categoryIds: categories }, true);
            for (let list = 0; list < 20; list += 1) collection(`col_list${list}`, { source: "manual", productIds: Array.from({ length: 60 }, pick) }, true);
        }
        collection("col_off", { source: "manual", productIds: [pick(), pick()] }, false);
        const statuses = ["confirmed", "delivered", "completed", "cancelled", "pending", "refunded"];
        for (let order = 0; order < (options.orders ?? size * 2); order += 1) {
            const orderId = `o_${order}`;
            // Within 30 days, within a year, and older.
            const createdAt = NOW - [3_600, 10 * 86_400, 200 * 86_400, 400 * 86_400][random(4)]!;
            const email = random(3) === 0;
            sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, status, created_at, updated_at)
                VALUES (?, 'Buyer', ?, ?, 'Road 1', 'city', 'zone', ?, ?, ?)`)
                .run(orderId, email ? "" : `0171${random(6)}`, email ? ` Buyer${random(6)}@Mail.test ` : null, statuses[random(statuses.length)]!, createdAt, createdAt);
            const lines = 1 + random(4);
            for (let line = 0; line < lines; line += 1) {
                sqlite.prepare("INSERT INTO order_items (id, order_id, product_id, quantity, created_at) VALUES (?, ?, ?, 1, ?)")
                    .run(`${orderId}_l${line}`, orderId, pick(), createdAt);
            }
        }
    }
    return ids;
}


/** Both projections for every product (one rebuild call stops at its limit). */
export async function rebuildEveryProjection(db: Database): Promise<void> {
    let after: string | null = null;
    for (;;) {
        const result = await rebuildCatalogProjections(db, { afterProductId: after, limit: 2_700, repairFacetCounts: after === null });
        if (result.done || result.nextAfterProductId === null) return;
        after = result.nextAfterProductId;
    }
}
