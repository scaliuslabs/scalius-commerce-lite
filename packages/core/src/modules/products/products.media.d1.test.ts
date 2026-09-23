import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";

import { updateProductMediaSection } from "./products.admin";
import {
    resolveProductMediaProjectionRows,
    resolveSkuImageRepresentation,
    selectCheckoutProductMediaProjectionRows,
} from "./products.media";

it("preserves joined media fields through object-shaped D1 batch results", async () => {
    const { sqlite: database, db } = createSqliteD1Database();
    database.exec(`
        INSERT INTO products (id, name, slug, price) VALUES ('product_1', 'Product 1', 'product-1', 100);
        INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, width, height, variant_width, duration_ms, poster_media_id, status) VALUES
            ('media_image', 'image.webp', 'image', 'media/image.webp', 1, 'image/webp', 'Image alt', 800, 800, NULL, NULL, NULL, 'ready'),
            ('media_poster', 'poster.webp', 'image', 'media/poster.webp', 1, 'image/webp', 'Poster alt', 800, 800, 800, NULL, NULL, 'ready'),
            ('media_video', 'video.mp4', 'video', 'media/video.mp4', 1, 'video/mp4', 'Video alt', 1280, 720, NULL, 2000, 'media_poster', 'ready');
        INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order) VALUES
            ('pmed_video', 'product_1', 'media_video', 'Context video', 1, 0),
            ('pmed_image', 'product_1', 'media_image', 'Context image', 0, 1);
        INSERT INTO product_variants (id, product_id, sku, price, is_default, image_id) VALUES ('variant_1', 'product_1', 'SKU-1', 100, 1, 'pmed_image');
    `);

    const [rows] = await db.batch([
        selectCheckoutProductMediaProjectionRows(db, ["product_1"], ["variant_1"]),
    ]);

    expect(rows).toEqual([
        expect.objectContaining({
            id: "pmed_video",
            kind: "video",
            objectKey: "media/video.mp4",
            contextualAltText: "Context video",
            posterMediaId: "media_poster",
            posterObjectKey: "media/poster.webp",
            posterVariantWidth: 800,
            posterKind: "image",
            posterStatus: "ready",
        }),
        expect.objectContaining({
            id: "pmed_image",
            kind: "image",
            objectKey: "media/image.webp",
            contextualAltText: "Context image",
            posterMediaId: null,
            posterObjectKey: null,
            posterKind: null,
            posterStatus: null,
        }),
    ]);
    const projections = resolveProductMediaProjectionRows(rows);
    expect(resolveSkuImageRepresentation(projections.get("product_1") ?? [], "pmed_image"))
        .toMatchObject({
            productMediaId: "pmed_image",
            mediaId: "media_image",
            source: "exact-sku",
        });
    database.close();
});

describe("product media section commands", () => {
    function setup() {
        const harness = createSqliteD1Database();
        harness.sqlite.exec(`
            INSERT INTO products (id, name, slug, price) VALUES ('product_1', 'Product 1', 'product-1', 100);
            INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES
                ('media_a', 'a.webp', 'image', 'media/a.webp', 1, 'image/webp', 'ready'),
                ('media_b', 'b.webp', 'image', 'media/b.webp', 1, 'image/webp', 'ready'),
                ('media_c', 'c.webp', 'image', 'media/c.webp', 1, 'image/webp', 'ready');
            INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES
                ('pmed_aaaaa', 'product_1', 'media_a', 1, 0),
                ('pmed_bbbbb', 'product_1', 'media_b', 0, 1),
                ('pmed_ccccc', 'product_1', 'media_c', 0, 2);
            INSERT INTO product_variants (id, product_id, sku, price, is_default, image_id) VALUES ('variant_1', 'product_1', 'SKU-1', 100, 1, 'pmed_bbbbb');
        `);
        const gallery = () => harness.sqlite.prepare(
            "SELECT id, is_primary AS isPrimary FROM product_media ORDER BY sort_order",
        ).all();
        const skuImage = () => harness.sqlite.prepare("SELECT image_id AS imageId FROM product_variants").get();
        return { ...harness, gallery, skuImage };
    }
    const item = (letter: string, isPrimary = false) =>
        ({ id: `pmed_${letter.repeat(5)}`, mediaId: `media_${letter}`, altText: null, isPrimary });

    it("reorders retained media across the unique sort range in one command", async () => {
        const { db, gallery } = setup();

        await updateProductMediaSection(db, "product_1", 1, [item("c", true), item("a"), item("b")]);

        expect(gallery()).toEqual([
            { id: "pmed_ccccc", isPrimary: 1 },
            { id: "pmed_aaaaa", isPrimary: 0 },
            { id: "pmed_bbbbb", isPrimary: 0 },
        ]);
    });

    it("requires explicit acknowledgement before removing an image a SKU still uses", async () => {
        const { db, gallery, skuImage } = setup();

        await expect(updateProductMediaSection(db, "product_1", 1, [item("a", true), item("c")]))
            .rejects.toMatchObject({
                code: "PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT",
                details: {
                    affectedAssociationIds: ["pmed_bbbbb"],
                    affectedSkus: [{ id: "variant_1", sku: "SKU-1", imageId: "pmed_bbbbb" }],
                },
            });
        expect(gallery()).toHaveLength(3);

        await updateProductMediaSection(db, "product_1", 1, [item("a", true), item("c")], ["pmed_bbbbb"]);
        expect(gallery()).toEqual([
            { id: "pmed_aaaaa", isPrimary: 1 },
            { id: "pmed_ccccc", isPrimary: 0 },
        ]);
        expect(skuImage()).toEqual({ imageId: null });
    });
});
