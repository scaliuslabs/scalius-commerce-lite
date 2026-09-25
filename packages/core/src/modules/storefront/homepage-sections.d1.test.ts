import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { safeBatch } from "@scalius/database/client";
import { describe, expect, it } from "vitest";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { storefrontSectionDefault, type StorefrontSection } from "@scalius/shared/storefront-theme";
import { planHomeBrands, planHomePromotions, readHomeSectionMedia } from "./homepage-sections";

describe("homepage brand wall and deal countdown reads", () => {
    it("counts only to a running promotion's stored end", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO promotions (id, name, method, status, starts_at, ends_at, deleted_at) VALUES
              ('p_run', 'Running', 'automatic', 'active', unixepoch() - 60, unixepoch() + 3600, NULL),
              ('p_code', 'Code', 'code', 'active', NULL, unixepoch() + 7200, NULL),
              ('p_open', 'No end', 'automatic', 'active', NULL, NULL, NULL),
              ('p_over', 'Over', 'automatic', 'active', unixepoch() - 7200, unixepoch() - 60, NULL),
              ('p_later', 'Later', 'automatic', 'active', unixepoch() + 600, unixepoch() + 3600, NULL),
              ('p_paused', 'Paused', 'automatic', 'paused', NULL, unixepoch() + 3600, NULL),
              ('p_trash', 'Trashed', 'automatic', 'active', NULL, unixepoch() + 3600, unixepoch());
        `);
        const plan = planHomePromotions(db, ["p_run", "p_code", "p_open", "p_over", "p_later", "p_paused", "p_trash"]);
        const ends = plan.resolve(await safeBatch(db, plan.statements), 0);
        expect(ends.map((each) => each.id).sort()).toEqual(["p_code", "p_run"]);
        for (const each of ends) expect(Date.parse(each.endsAt)).toBeGreaterThan(Date.now());
        expect(planHomePromotions(db, []).statements).toEqual([]);
    });

    it("lists published, live brands that have a public product, in merchant order", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'A', 'a', 'published');
            INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
              ('m_logo', 'logo.png', 'image', 'media/logo.png', 1, 'image/png', 'ready', 200, 100, 200);
            INSERT INTO brands (id, name, slug, status, sort_order, logo_media_id, deleted_at) VALUES
              ('brd_second0', 'Walton', 'walton', 'published', 2, NULL, NULL),
              ('brd_first00', 'Aarong', 'aarong', 'published', 1, 'm_logo', NULL),
              ('brd_empty00', 'Empty', 'empty', 'published', 0, NULL, NULL),
              ('brd_draft00', 'Draft', 'draft', 'draft', 0, NULL, NULL),
              ('brd_trash00', 'Trash', 'trash', 'published', 0, NULL, unixepoch());
            INSERT INTO products (id, name, price_minor, slug, category_id, is_active, brand_id) VALUES
              ('p1', 'One', 1000, 'one', 'cat_a', 1, 'brd_first00'),
              ('p2', 'Two', 1000, 'two', 'cat_a', 1, 'brd_second0'),
              ('p3', 'Three', 1000, 'three', 'cat_a', 1, 'brd_draft00'),
              ('p4', 'Four', 1000, 'four', 'cat_a', 0, 'brd_empty00');
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
              ('v1', 'p1', 'S1', 1000, 5, 0, 1, 1), ('v2', 'p2', 'S2', 1000, 5, 0, 1, 1),
              ('v3', 'p3', 'S3', 1000, 5, 0, 1, 1), ('v4', 'p4', 'S4', 1000, 5, 0, 1, 1);
        `);
        await rebuildCatalogProjections(db);
        const plan = planHomeBrands(db, 24);
        const wall = plan.resolve(await safeBatch(db, plan.statements), 0);
        expect(wall.map((brand) => brand.id)).toEqual(["brd_first00", "brd_second0"]);
        expect(wall[0]!.logo).toMatchObject({ mediaId: "m_logo", alt: "Aarong" });
        expect(wall[1]!.logo).toBeNull();
        expect(planHomeBrands(db, 0).statements).toEqual([]);
    });

    it("reads the images a theme's sections name, for the dashboard's previews", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width, alt_text, trashed_at, deleted_at) VALUES
              ('m_card', 'card.jpg', 'image', 'media/card.jpg', 1, 'image/jpeg', 'ready', 800, 800, 800, 'Eid', NULL, NULL),
              ('m_video', 'clip.mp4', 'video', 'media/clip.mp4', 1, 'video/mp4', 'ready', 800, 800, NULL, NULL, NULL, NULL),
              ('m_gone', 'gone.jpg', 'image', 'media/gone.jpg', 1, 'image/jpeg', 'deleted', 800, 800, 800, NULL, unixepoch(), unixepoch());
        `);
        const shopBy = storefrontSectionDefault("shop-by", "cards");
        const sections: StorefrontSection[] = [{
            ...shopBy,
            settings: { title: "", cards: ["m_card", "m_video", "m_gone"].map((mediaId) => ({ mediaId, title: mediaId, href: "/sale" })) },
        }];
        const media = await readHomeSectionMedia(db, sections);
        expect(media.map((each) => [each.id, each.alt])).toEqual([["m_card", "Eid"]]);
        expect(await readHomeSectionMedia(db, [])).toEqual([]);
    });
});
