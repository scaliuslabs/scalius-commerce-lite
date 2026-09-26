// A product editor save that changes nothing is a true no-op: no revision
// bump, no updated_at, no row rewritten, no cache dependency advanced. A save
// that changes one thing bumps the revision once.
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it, vi } from "vitest";

import { createProduct, updateProduct } from "./write";
import { createProductSchema, updateProductSchema } from "../validation";

vi.mock("../../inventory/alerts", () => ({ checkAndAlertLowStock: vi.fn() }));

const SEED = `
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_mugs', 'Mugs', 'mugs', 'published');
    INSERT INTO brands (id, name, slug, status) VALUES ('brd_potter01', 'Potter', 'potter', 'published');
    INSERT INTO product_attributes (id, name, slug, filterable, value_type, facet_display) VALUES
        ('attr_mat', 'Material', 'material', 1, 'text', 'checkbox'),
        ('attr_cap', 'Capacity', 'capacity', 1, 'number', 'range'),
        ('attr_col', 'Colour', 'colour', 1, 'enum', 'checkbox');
    INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order) VALUES ('atv_blue0001', 'attr_col', 'Blue', 'blue', 0);
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height) VALUES
        ('media_aaaa01', 'a.jpg', 'image', 'media/a.jpg', 1, 'image/jpeg', 'ready', 800, 800),
        ('media_bbbb01', 'b.jpg', 'image', 'media/b.jpg', 1, 'image/jpeg', 'ready', 800, 800);
`;

const input = {
    name: "Stoneware mug",
    description: "<p>Hand thrown.</p>",
    price: 650,
    categoryId: "cat_mugs",
    brandId: "brd_potter01",
    isActive: true,
    discountType: "percentage" as const,
    discountPercentage: 10,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: "Stoneware mug",
    metaDescription: null,
    canonicalPath: null,
    productCondition: "new" as const,
    slug: "stoneware-mug",
    media: [
        { id: "pmed_aaaa01", mediaId: "media_aaaa01", altText: "Front", isPrimary: true },
        { id: "pmed_bbbb01", mediaId: "media_bbbb01", altText: null, isPrimary: false },
    ],
    attributes: [
        { attributeId: "attr_mat", value: "Stoneware" },
        { attributeId: "attr_cap", value: "350" },
        { attributeId: "attr_col", value: "blue" },
    ],
    additionalInfo: [],
};

describe("product editor save", () => {
    it("writes nothing when the saved aggregate equals the stored one, and bumps once on a real change", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(SEED);
        const { id } = await createProduct(db, createProductSchema.parse(input));
        // The editor adds rich content; its ids come back from the server.
        const first = await updateProduct(db, id, updateProductSchema.parse({
            ...input,
            id,
            additionalInfo: [{ id: "item-1", title: "Care", content: "<p>Dishwasher safe.</p>", sortOrder: 0 }],
            expectedAggregateRevision: 1,
        }));
        const contentId = (sqlite.prepare("SELECT id FROM product_rich_content WHERE product_id = ?").get(id) as { id: string }).id;
        const saved = {
            ...input,
            id,
            additionalInfo: [{ id: contentId, title: "Care", content: "<p>Dishwasher safe.</p>", sortOrder: 0 }],
        };

        const state = () => ({
            product: sqlite.prepare("SELECT aggregate_revision, updated_at FROM products WHERE id = ?").get(id),
            deps: sqlite.prepare("SELECT dep, seq FROM cache_dep ORDER BY dep").all(),
            clock: sqlite.prepare("SELECT seq FROM cache_clock").get(),
            attributeRows: sqlite.prepare("SELECT id FROM product_attribute_values WHERE product_id = ? ORDER BY id").all(id),
            mediaRows: sqlite.prepare("SELECT id, updated_at FROM product_media WHERE product_id = ? ORDER BY id").all(id),
            skus: sqlite.prepare("SELECT id, updated_at FROM product_variants WHERE product_id = ? ORDER BY id").all(id),
        });
        const before = state();

        const again = await updateProduct(db, id, updateProductSchema.parse({ ...saved, expectedAggregateRevision: first.aggregateRevision }));
        expect(again).toEqual({ aggregateRevision: first.aggregateRevision });
        expect(state()).toEqual(before);

        // A stale revision is still a conflict, change or not.
        await expect(updateProduct(db, id, updateProductSchema.parse({ ...saved, expectedAggregateRevision: first.aggregateRevision - 1 })))
            .rejects.toMatchObject({ code: "PRODUCT_REVISION_CONFLICT" });

        // One price change: one bump, and the product's own key advances.
        const clock = (sqlite.prepare("SELECT seq FROM cache_clock").get() as { seq: number }).seq;
        const changed = await updateProduct(db, id, updateProductSchema.parse({
            ...saved,
            price: 700,
            expectedAggregateRevision: first.aggregateRevision,
        }));
        expect(changed).toEqual({ aggregateRevision: first.aggregateRevision + 1 });
        const advanced = (sqlite.prepare("SELECT dep FROM cache_dep WHERE seq > ?").all(clock) as Array<{ dep: string }>).map((row) => row.dep);
        expect(advanced).toContain(`p:${id}`);

        // Each part of the aggregate is compared: alt text, media order, an attribute, rich content.
        let revision = changed.aggregateRevision;
        for (const variant of [
            { ...saved, price: 700, media: [{ ...saved.media[0]!, altText: "Front view" }, saved.media[1]!] },
            { ...saved, price: 700, media: [{ ...saved.media[1]!, isPrimary: true }, { ...saved.media[0]!, altText: "Front view", isPrimary: false }] },
            { ...saved, price: 700, attributes: [...saved.attributes.slice(0, 2), { attributeId: "attr_col", value: "Blue" }].map((row, index) => index === 1 ? { ...row, value: "400" } : row) },
            { ...saved, price: 700, additionalInfo: [{ ...saved.additionalInfo[0]!, content: "<p>Hand wash.</p>" }] },
        ]) {
            const media = variant.media;
            const result = await updateProduct(db, id, updateProductSchema.parse({ ...variant, media, expectedAggregateRevision: revision }));
            expect(result.aggregateRevision).toBe(revision + 1);
            revision = result.aggregateRevision;
            // Saving the same again is a no-op.
            const repeat = await updateProduct(db, id, updateProductSchema.parse({ ...variant, media, expectedAggregateRevision: revision }));
            expect(repeat.aggregateRevision).toBe(revision);
            saved.media = media;
            saved.attributes = variant.attributes;
            saved.additionalInfo = variant.additionalInfo;
        }
    });
});
