// Product content blocks on the real migrated schema (0090): the editor
// section under the aggregate revision, the legacy tabs 0090 mirrors from
// `product_rich_content`, and the product page's one ordered read.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { productContentBlockDefault } from "@scalius/shared/product-content-blocks";
import { getStorefrontProductBySlug } from "../catalog/product-page";
import { withDependencyScope } from "../../cache-deps";
import { loadMediaUsage } from "../media/media.usage";
import {
    PRODUCT_CONTENT_BLOCK_TEXT_CHUNK_MAX,
    productContentBlockInputListSchema,
    type ProductContentBlockInput,
} from "./content-blocks";
import {
    PRODUCT_SEMANTIC_RESULT_MAX_BYTES,
    getProductSemanticSection,
    productSemanticSectionPatchSchema,
    updateProductSemanticSection,
} from "./semantic-sections";

const LONG_TITLE = "Care & washing ".repeat(20).trim();

describe("product content blocks", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO products (id, name, slug, price_minor, is_active, description) VALUES
              ('prod_1', 'Honey', 'honey', 90000, 1, 'Raw honey from the Sundarbans.');
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
              VALUES ('var_1', 'prod_1', 'HONEY-1', 90000, 10, 1, 1);
            INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, alt_text, width, height, trashed_at) VALUES
              ('med_photo', 'jar.jpg', 'image', 'media/jar.jpg', 1, 'image/jpeg', 'ready', 'A jar', 800, 600, NULL),
              ('med_clip', 'harvest.mp4', 'video', 'media/harvest.mp4', 1, 'video/mp4', 'ready', NULL, NULL, NULL, NULL),
              ('med_trashed', 'old.jpg', 'image', 'media/old.jpg', 1, 'image/jpeg', 'trashed', NULL, NULL, NULL, unixepoch());
            -- Legacy tabs, inserted out of order, one with a title longer than a block title may be.
            INSERT INTO product_rich_content (id, product_id, title, content, sort_order) VALUES
              ('prc_care', 'prod_1', '${LONG_TITLE}', '<p>Keep dry.</p>', 2),
              ('prc_origin', 'prod_1', 'Origin', '<p>Sundarbans<script>x()</script></p>', 0),
              ('prc_use', 'prod_1', 'How to use', '<ul><li>Tea</li></ul>', 1);
        `);
    });

    afterEach(() => sqlite.close());

    const revision = () => Number((sqlite.prepare("SELECT aggregate_revision AS r FROM products WHERE id = 'prod_1'").get() as { r: number }).r);
    const replace = (blocks: unknown[]) => updateProductSemanticSection(db, "prod_1", productSemanticSectionPatchSchema.parse({
        section: "content_blocks",
        expectedAggregateRevision: revision(),
        blocks,
    }) as never);
    const block = (placement: string, value: { type: string; version: number; settings: unknown }) => ({ placement, ...value });

    it("serves the legacy tabs exactly as the product_rich_content read did (classic page unchanged)", async () => {
        const legacy = sqlite.prepare("SELECT id, title, content FROM product_rich_content WHERE product_id = 'prod_1' ORDER BY sort_order").all();
        const page = await getStorefrontProductBySlug(db, "honey");

        expect(page!.product.additionalInfo).toEqual(legacy.map((row) => ({ ...row })));
        expect(page!.product.additionalInfo.map((tab) => tab.id)).toEqual(["prc_origin", "prc_use", "prc_care"]);
        expect(page!.product).toMatchObject({ contentBlocks: [], contentBlockMedia: [], bundles: [], emi: null, pageTemplate: null });
    });

    it("lists legacy tabs as read-only blocks and never lets the section touch them", async () => {
        const section = await getProductSemanticSection(db, "prod_1", "content_blocks", { offset: 0, limit: 50 });
        expect(section).toMatchObject({ section: "content_blocks", total: 3 });
        expect((section as { items: Array<{ id: string; legacy: boolean }> }).items.map((item) => [item.id, item.legacy])).toEqual([
            ["pcb_prc_origin", true],
            ["pcb_prc_use", true],
            ["pcb_prc_care", true],
        ]);

        await expect(replace([{ id: "pcb_prc_origin", placement: "tabs", keep: true }]))
            .rejects.toMatchObject({ status: 400, message: expect.stringContaining("Additional information") });
        // An empty replace removes only the section's own blocks.
        await replace([]);
        expect(sqlite.prepare("SELECT count(*) AS n FROM product_content_blocks").get()).toEqual({ n: 3 });
    });

    it("replaces blocks in page order, sanitises HTML, keeps and moves blocks without resending them", async () => {
        const before = revision();
        await replace([
            block("after-description", { ...productContentBlockDefault("faq"), settings: { heading: "FAQ", items: [{ question: "Pure?", answer: "Yes." }] } }),
            block("tabs", { type: "rich-text", version: 1, settings: { title: "Shipping", html: "<p onclick=\"x()\">Fast<script>alert(1)</script></p>" } }),
            block("after-buy-box", { type: "guarantee", version: 1, settings: { heading: "", text: "Money back in 7 days." } }),
        ]);
        expect(revision()).toBe(before + 1);
        const rows = sqlite.prepare(`SELECT id, placement, position, type, settings FROM product_content_blocks
            WHERE id NOT LIKE 'pcb_prc_%' ORDER BY placement, position`).all() as Array<{ id: string; placement: string; position: number; type: string; settings: string }>;
        expect(rows.map((row) => [row.placement, row.position, row.type])).toEqual([
            ["after-buy-box", 0, "guarantee"],
            ["after-description", 0, "faq"],
            ["tabs", 3, "rich-text"],
        ]);
        const html = JSON.parse(rows.find((row) => row.type === "rich-text")!.settings).html as string;
        expect(html).not.toMatch(/script|onclick/);
        expect(html).toContain("Fast");

        const [guarantee, faq, tab] = rows;
        await replace([
            { id: faq!.id, placement: "before-reviews", keep: true },
            { id: guarantee!.id, placement: "after-buy-box", type: "guarantee", version: 1, settings: { heading: "Promise", text: "Money back in 14 days." } },
        ]);
        const after = sqlite.prepare(`SELECT id, placement, position, settings FROM product_content_blocks
            WHERE id NOT LIKE 'pcb_prc_%' ORDER BY id`).all() as Array<{ id: string; placement: string; position: number; settings: string }>;
        expect(after).toHaveLength(2);
        expect(after.find((row) => row.id === faq!.id)).toMatchObject({ placement: "before-reviews", position: 0 });
        expect(JSON.parse(after.find((row) => row.id === guarantee!.id)!.settings)).toEqual({ heading: "Promise", text: "Money back in 14 days." });
        expect(after.some((row) => row.id === tab!.id)).toBe(false);
    });

    it("refuses anything the strict block schemas refuse, before writing", async () => {
        const start = revision();
        const refused: unknown[][] = [
            [block("tabs", { type: "marquee", version: 1, settings: {} })],
            [block("tabs", { type: "guarantee", version: 1, settings: { heading: "", text: "x" } })],
            [block("after-buy-box", { type: "guarantee", version: 1, settings: { heading: "", text: "x", extra: true } })],
            [block("after-buy-box", { type: "guarantee", version: 2, settings: { heading: "", text: "x" } })],
            [block("after-buy-box", { type: "cta-band", version: 1, settings: { heading: "", text: "", label: "Buy", target: { kind: "link", href: "javascript:alert(1)" }, endsAt: null } })],
            [block("after-buy-box", { type: "statement", version: 1, settings: { text: "Pure honey", accent: "sugar" } })],
            [block("after-buy-box", { type: "image-with-text", version: 1, settings: { heading: "", body: "", mediaId: "med_trashed", imageSide: "start", cta: null } })],
            [block("after-buy-box", { type: "image-with-text", version: 1, settings: { heading: "", body: "", mediaId: "med_clip", imageSide: "start", cta: null } })],
            [block("after-buy-box", { type: "video", version: 1, settings: { heading: "", source: { kind: "media", mediaId: "med_photo" } } })],
            [{ id: "pcb_unknown123", placement: "tabs", keep: true }],
        ];
        for (const blocks of refused) {
            await expect(replace(blocks), JSON.stringify(blocks)).rejects.toMatchObject({ status: 400 });
        }
        expect(revision()).toBe(start);
        // 40 blocks per product, the three legacy tabs included.
        const guarantee = block("after-buy-box", { type: "guarantee", version: 1, settings: { heading: "", text: "x" } });
        expect(productContentBlockInputListSchema.safeParse(Array.from({ length: 41 }, () => guarantee)).success).toBe(false);
        await expect(replace(Array.from({ length: 38 }, () => guarantee))).rejects.toMatchObject({ status: 400 });
        await replace(Array.from({ length: 37 }, () => guarantee));
    });

    it("reports a stale revision as a conflict and changes nothing", async () => {
        const stale = revision();
        await replace([]);
        await expect(updateProductSemanticSection(db, "prod_1", {
            section: "content_blocks",
            expectedAggregateRevision: stale,
            blocks: [block("after-buy-box", { type: "guarantee", version: 1, settings: { heading: "", text: "x" } })] as ProductContentBlockInput[],
        })).rejects.toMatchObject({ status: 409, code: "PRODUCT_REVISION_CONFLICT" });
        expect(sqlite.prepare("SELECT count(*) AS n FROM product_content_blocks WHERE type = 'guarantee'").get()).toEqual({ n: 0 });
    });

    it("keeps the section bounded: large settings are read back in chunks", async () => {
        const html = `<p>${"মধু ".repeat(20_000)}</p>`;
        await replace([block("after-description", { type: "rich-text", version: 1, settings: { title: "Story", html } })]);
        const list = await getProductSemanticSection(db, "prod_1", "content_blocks", { offset: 0, limit: 50 }) as {
            items: Array<{ id: string; settings: unknown; settingsCharacters: number }>;
        };
        expect(new TextEncoder().encode(JSON.stringify(list)).byteLength).toBeLessThan(PRODUCT_SEMANTIC_RESULT_MAX_BYTES);
        const story = list.items.find((item) => !item.id.startsWith("pcb_prc_"))!;
        expect(story.settings).toBeNull();

        let text = "";
        let offset: number | null = 0;
        while (offset !== null) {
            const chunk = await getProductSemanticSection(db, "prod_1", "content_block", { offset, limit: 20, itemId: story.id }) as {
                value: string; nextOffset: number | null;
            };
            expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThan(PRODUCT_SEMANTIC_RESULT_MAX_BYTES);
            expect(chunk.value.length).toBeLessThanOrEqual(PRODUCT_CONTENT_BLOCK_TEXT_CHUNK_MAX);
            text += chunk.value;
            offset = chunk.nextOffset;
        }
        expect(JSON.parse(text)).toEqual({ title: "Story", html });
    });

    it("loads a file video poster from that video's media reference", async () => {
        sqlite.exec("UPDATE media SET poster_media_id = 'med_photo' WHERE id = 'med_clip'; UPDATE media SET variant_width = 800 WHERE id = 'med_photo'");
        await replace([block("after-buy-box", { type: "video", version: 1, settings: {
            heading: "Harvest", source: { kind: "media", mediaId: "med_clip" },
        } })]);
        const read = () => withDependencyScope(() => getStorefrontProductBySlug(db, "honey"), { strict: true });
        const { value: page, dependencies } = await read();
        expect(page!.product.contentBlockMedia).toEqual([expect.objectContaining({
            id: "med_clip", kind: "video", posterUrl: expect.stringContaining("media/jar.jpg/800.webp"),
        })]);
        expect(dependencies.keys).toEqual(expect.arrayContaining(["m:med_clip", "m:med_photo"]));
        sqlite.exec("UPDATE media SET status = 'trashed', trashed_at = unixepoch() WHERE id = 'med_photo'");
        const hidden = await read();
        expect(hidden.value!.product.contentBlockMedia[0]!.posterUrl).toBeNull();
        expect(hidden.dependencies.keys).toContain("m:med_photo");
    });

    it("renders blocks on the product page in placement then page order, with their files", async () => {
        await replace([
            block("before-reviews", { type: "guarantee", version: 1, settings: { heading: "", text: "Money back." } }),
            block("after-buy-box", { type: "video", version: 1, settings: { heading: "Harvest", source: { kind: "embed", url: "https://youtu.be/dQw4w9WgXcQ", posterMediaId: "med_photo" } } }),
            block("after-buy-box", { type: "gallery-strip", version: 1, settings: { heading: "", mediaIds: ["med_photo"] } }),
            block("tabs", { type: "rich-text", version: 1, settings: { title: "Shipping", html: "<p>Fast</p>" } }),
            block("tabs", { type: "faq", version: 1, settings: { heading: "", items: [{ question: "Q", answer: "A" }] } }),
        ]);
        // A stored block that no longer validates is left out, not rendered wrong.
        sqlite.exec(`INSERT INTO product_content_blocks (id, product_id, placement, position, type, version, settings)
            VALUES ('pcb_broken01', 'prod_1', 'after-buy-box', 9, 'guarantee', 1, '{"text":""}')`);

        const page = await getStorefrontProductBySlug(db, "honey");
        const product = page!.product;
        expect(product.additionalInfo.map((tab) => tab.title)).toEqual(["Origin", "How to use", LONG_TITLE, "Shipping"]);
        expect(product.contentBlocks.map((each) => [each.placement, each.type])).toEqual([
            ["tabs", "faq"],
            ["after-buy-box", "video"],
            ["after-buy-box", "gallery-strip"],
            ["before-reviews", "guarantee"],
        ]);
        expect(product.contentBlockMedia).toEqual([expect.objectContaining({
            id: "med_photo", kind: "image", altText: "A jar", width: 800, height: 600,
        })]);
        expect(product.contentBlockMedia[0]!.url).toContain("media/jar.jpg");

        // Files the blocks name are in use: they show in "Used in" and cannot be deleted.
        const usage = await loadMediaUsage(db, "med_photo");
        expect(usage.references).toEqual([expect.objectContaining({ kind: "product", id: "prod_1" })]);
    });
});
