/**
 * A small store that uses every buyer-visible table the DVC registry lists,
 * so the row-mutation generator has a real row to update, clone or delete in
 * each of them: a three-level category tree, brands, simple and optioned
 * products with media, attributes, facets, rich content, bundles, manual and
 * dynamic collections, CMS pages and articles, a published navigation,
 * settings documents, a theme using every section type (with brand images,
 * an announcement, footer words, hero slides, category tiles, collections
 * and a product homepage), shipping,
 * locations, tax, markets (an active subfolder market and a draft one) with
 * FX pricing and price lists of every kind,
 * scheduled promotions, checkout languages, analytics,
 * reviews of a delivered order's lines, warranty policies and custom fields.
 *
 * Deterministic: fixed ids and a fixed epoch (`DVC_SEED_EPOCH`).
 */
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { refreshProductRecommendations, refreshProductSalesStats } from "@scalius/core/modules/catalog";
import {
  STOREFRONT_SECTION_TYPES,
  storefrontSectionDefault,
  storefrontTemplateTheme,
  type StorefrontSection,
} from "@scalius/shared/storefront-theme";
import { PLUGIN_API_VERSION, parsePluginManifest, pluginGrantKey, pluginGrantRequest } from "@scalius/shared/plugins";
import { recordIndexColumns } from "@scalius/core/modules/plugins";

/** Seconds; 2026-09-21T14:13:20Z. Simulated time starts here. */
export const DVC_SEED_EPOCH = 1_790_000_000;
const DAY = 86_400;

/** Ids the route catalogue and the scheduled-time actions refer to. */
export const DVC_IDS = {
  products: ["p_linen", "p_cotton", "p_silk", "p_kurta", "p_saree", "p_shoe", "p_bag", "p_watch", "p_draft", "p_gift"],
  productSlugs: ["linen-panjabi", "cotton-panjabi", "silk-panjabi", "kurta-set", "jamdani-saree", "loafer", "tote-bag", "field-watch", "draft-item", "gift-card"],
  categorySlugs: ["men", "panjabi", "festive-panjabi", "women", "saree", "accessories", "hidden-internal"],
  brandSlugs: ["aarong", "yellow", "draft-brand"],
  collections: ["col_manual", "col_dynamic", "col_hidden"],
  pageSlugs: ["about", "shipping-policy", "eid-lookbook"],
  landingSlugs: ["eid"],
  menus: ["menu_main", "menu_footer"],
  promotionBoundaries: [DVC_SEED_EPOCH + 3 * DAY, DVC_SEED_EPOCH + 5 * DAY, DVC_SEED_EPOCH + 9 * DAY, DVC_SEED_EPOCH + 12 * DAY],
} as const;

/** The seeded published theme: every section type and every kind of theme content. */
export function everySectionTheme() {
  const theme = storefrontTemplateTheme("department-mall");
  const sections: StorefrontSection[] = STOREFRONT_SECTION_TYPES.map((type, index) => storefrontSectionDefault(type, `s${index}`));
  const set = (type: string, settings: Record<string, unknown>, id = type) => {
    const section = { id, type, version: 1, settings } as StorefrontSection;
    const at = sections.findIndex((each) => each.type === type && each.id.startsWith("s"));
    if (at >= 0 && id === type) sections[at] = section;
    else sections.push(section);
  };
  set("hero", {
    layout: "contained-banners",
    slides: [
      { image: "media_hero", phoneImage: "media_side", focalPoint: { x: 40, y: 60 }, alt: "Eid", heading: "Eid", buttonLabel: "Shop", link: "/collections/col_manual" },
      { image: "media_banner", focalPoint: { x: 50, y: 50 }, alt: "Banner", link: null },
    ],
    sideBanners: [{ mediaId: "media_side", alt: "Side", href: "/sale" }],
  });
  // A draft category among the tiles: publishing it later must show it.
  set("category-tiles", { style: "photo", title: "Shop by category", categoryIds: ["cat_panjabi", "cat_saree", "cat_draft"] });
  set("collections", { carousel: "large", collectionIds: ["col_manual", "col_dynamic", "col_hidden"] });
  set("product-rail", { title: "", source: { kind: "popular" }, limit: 12 });
  set("product-grid", { title: "", source: { kind: "category", categoryId: "cat_panjabi" }, columns: 4, rows: 2 });
  set("deal-block", { title: "", source: { kind: "on-sale" } });
  set("lookbook", { title: "", mediaId: "media_look", source: { kind: "collection", collectionId: "col_manual" }, photo: "tall" });
  set("banner", { layout: "two-up", heading: "Eid", text: "", mediaId: "media_banner", cta: null });
  set("editorial", { layout: "image-with-text", heading: "Story", body: "Woven by hand.", mediaId: "media_story", imageSide: "end" });
  set("product-rail", { title: "", source: { kind: "newest" }, limit: 8 }, "rail-newest");
  theme.pages.home = sections;
  theme.pages.landing = {
    eid: { title: "ঈদের বাছাই", description: "", sections: structuredClone(sections) },
  };
  // A product homepage: the homepage read follows the product's buyer state.
  theme.pages.homeMode = { kind: "product", productId: "p_linen" };
  theme.brand = { logo: "media_logo", logoWidth: 180, footerLogo: "media_story", favicon: "media_side" };
  theme.blocks.topBar = { variant: "utility", settings: { text: "Free delivery in Dhaka", link: "/shipping-policy" } };
  theme.blocks.footer = { ...theme.blocks.footer, settings: { ...theme.blocks.footer.settings, tagline: "Handmade", about: "Since 1978", copyright: "Test Store Ltd" } } as typeof theme.blocks.footer;
  return theme;
}
const q = (value: unknown) => `'${(typeof value === "string" ? value : JSON.stringify(value)).replace(/'/g, "''")}'`;
const T = DVC_SEED_EPOCH;

/**
 * Installed apps and their records (0110 registers the plugin tables): an
 * active app with every index slot filled and a disabled one, so the
 * generator can insert, update and delete each plugin table and move every
 * noise column (revisions, index columns, timestamps, actors).
 */
function pluginSeedSql(): string {
  const storage = { notes: { indexes: ["owner", "kind", "at", "tag"], unique: ["ref", "code"] } };
  const manifestOf = (id: string) => {
    const parsed = parsePluginManifest({
      id, name: `DVC app ${id}`, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "A DVC seed app.",
      author: { name: "DVC" }, events: ["order.paid"], functions: [{ point: "checkout.discounts" }], storage,
    });
    if (!parsed.ok) throw new Error(`DVC seed manifest: ${JSON.stringify(parsed.issues)}`);
    return parsed.manifest;
  };
  const active = manifestOf("acme.dvc-active");
  const disabled = manifestOf("acme.dvc-disabled");
  const grant = (manifest: ReturnType<typeof manifestOf>) => pluginGrantRequest(manifest);
  const record = (id: string, data: Record<string, unknown>, at: number) => {
    const columns = recordIndexColumns(storage.notes, data);
    const value = (column: string) => (columns[column] === null ? "NULL" : q(columns[column]));
    return `('acme.dvc-active', 'notes', ${q(id)}, ${q(data)}, ${at - T + 1}, ${value("idx1")}, ${value("idx2")}, ${value("idx3")}, ${value("idx4")}, ${value("uq1")}, ${value("uq2")}, ${at}, ${at})`;
  };
  return `
  INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES
    ('usr_dvc_owner', 'Owner', 'owner@dvc.test', 1, 'admin', 1),
    ('usr_dvc_staff', 'Staff', 'staff@dvc.test', 1, 'admin', 0);
  INSERT INTO plugin_installations (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status, failure_reason, settings_json, revision, installed_by, activated_by, installed_at, activated_at, updated_at) VALUES
    ('acme.dvc-active', '1.0.0', 'upload', '${"a".repeat(64)}', ${q(active)}, ${q(grant(active))}, ${q(pluginGrantKey(grant(active)))}, 'active', NULL, '{}', 2, 'usr_dvc_owner', 'usr_dvc_owner', ${T}, ${T + 60}, ${T + 60}),
    ('acme.dvc-disabled', '1.0.0', 'upload', '${"b".repeat(64)}', ${q(disabled)}, ${q(grant(disabled))}, ${q(pluginGrantKey(grant(disabled)))}, 'disabled', 'The app could not be loaded.', '{}', 3, 'usr_dvc_staff', 'usr_dvc_staff', ${T + 10}, ${T + 70}, ${T + 90});
  INSERT INTO plugin_registrations (kind, name, plugin_id, priority) VALUES
    ('function', 'checkout.discounts', 'acme.dvc-active', 100),
    ('event', 'order.paid', 'acme.dvc-active', 100),
    ('function', 'checkout.discounts', 'acme.dvc-disabled', 200);
  INSERT INTO plugin_records (plugin_id, collection, id, data_json, revision, idx1, idx2, idx3, idx4, uq1, uq2, created_at, updated_at) VALUES
    ${record("n1", { owner: "c1", kind: "earn", at: 1, tag: "eid", ref: "r1", code: "A" }, T + 1)},
    ${record("n2", { owner: "c2", kind: "spend", at: 2, tag: "vip", ref: "r2", code: "B" }, T + 2)},
    ${record("n3", { owner: "c3", kind: "earn", at: 3, tag: "new", ref: "r3", code: "C" }, T + 3)};
  `;
}

function seedSql(): string {
  const promoStart = DVC_IDS.promotionBoundaries[0];
  const promoEnd = DVC_IDS.promotionBoundaries[2];
  return `
  -- Category tree (triggers keep depth, path and category_closure).
  INSERT INTO categories (id, name, slug, status, description, parent_id, created_at, updated_at) VALUES
    ('cat_men', 'Men', 'men', 'published', 'Menswear', NULL, ${T}, ${T}),
    ('cat_women', 'Women', 'women', 'published', 'Womenswear', NULL, ${T}, ${T}),
    ('cat_acc', 'Accessories', 'accessories', 'published', NULL, NULL, ${T}, ${T}),
    ('cat_internal', 'Hidden internal', 'hidden-internal', 'internal', NULL, NULL, ${T}, ${T});
  INSERT INTO categories (id, name, slug, status, description, parent_id, created_at, updated_at) VALUES
    ('cat_panjabi', 'Panjabi', 'panjabi', 'published', 'Panjabi for every day', 'cat_men', ${T}, ${T}),
    ('cat_saree', 'Saree', 'saree', 'published', NULL, 'cat_women', ${T}, ${T});
  INSERT INTO categories (id, name, slug, status, description, parent_id, created_at, updated_at) VALUES
    ('cat_festive', 'Festive Panjabi', 'festive-panjabi', 'published', 'For Eid', 'cat_panjabi', ${T}, ${T}),
    ('cat_draft', 'Draft category', 'draft-category', 'draft', NULL, 'cat_women', ${T}, ${T});

  INSERT INTO brands (id, name, slug, status, description, created_at, updated_at) VALUES
    ('brd_aarong01', 'Aarong', 'aarong', 'published', 'Crafts', ${T}, ${T}),
    ('brd_yellow01', 'Yellow', 'yellow', 'published', NULL, ${T}, ${T}),
    ('brd_draft001', 'Draft brand', 'draft-brand', 'draft', NULL, ${T}, ${T});

  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width, alt_text, created_at, updated_at) VALUES
    ('media_linen', 'linen.jpg', 'image', 'media/linen.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600, 'Linen', ${T}, ${T}),
    ('media_cotton', 'cotton.jpg', 'image', 'media/cotton.jpg', 1, 'image/jpeg', 'ready', 1200, 1600, 1200, NULL, ${T}, ${T}),
    ('media_silk', 'silk.jpg', 'image', 'media/silk.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, NULL, NULL, ${T}, ${T}),
    ('media_saree', 'saree.jpg', 'image', 'media/saree.jpg', 1, 'image/jpeg', 'ready', 1600, 2000, 1600, NULL, ${T}, ${T}),
    ('media_hero', 'hero.jpg', 'image', 'media/hero.jpg', 1, 'image/jpeg', 'ready', 1600, 600, 1600, NULL, ${T}, ${T}),
    ('media_side', 'side.jpg', 'image', 'media/side.jpg', 1, 'image/jpeg', 'ready', 600, 480, 600, NULL, ${T}, ${T}),
    ('media_look', 'look.jpg', 'image', 'media/look.jpg', 1, 'image/jpeg', 'ready', 800, 800, 800, NULL, ${T}, ${T}),
    ('media_banner', 'banner.jpg', 'image', 'media/banner.jpg', 1, 'image/jpeg', 'ready', 1600, 500, 1600, NULL, ${T}, ${T}),
    ('media_story', 'story.jpg', 'image', 'media/story.jpg', 1, 'image/jpeg', 'ready', 1200, 900, 1200, NULL, ${T}, ${T}),
    ('media_logo', 'logo.png', 'image', 'media/logo.png', 1, 'image/png', 'ready', 400, 400, 400, NULL, ${T}, ${T});
  UPDATE brands SET logo_media_id = 'media_logo' WHERE id = 'brd_aarong01';

  INSERT INTO products (id, name, description, price_minor, slug, category_id, brand_id, is_active, discount_type, discount_bps, discount_amount_minor, product_condition, meta_title, no_index, exclude_from_sitemap, created_at, updated_at) VALUES
    ('p_linen', 'Linen Panjabi', '<p>Breathable linen.</p>', 250000, 'linen-panjabi', 'cat_panjabi', 'brd_aarong01', 1, NULL, 0, 0, 'new', 'Linen Panjabi | Store', 0, 0, ${T - 9 * DAY}, ${T}),
    ('p_cotton', 'Cotton Panjabi', '<p>Soft cotton.</p>', 180000, 'cotton-panjabi', 'cat_panjabi', 'brd_yellow01', 1, 'percentage', 1000, 0, 'new', NULL, 0, 0, ${T - 8 * DAY}, ${T}),
    ('p_silk', 'Silk Panjabi', '<p>Silk for Eid.</p>', 520000, 'silk-panjabi', 'cat_festive', 'brd_aarong01', 1, 'fixed', 0, 20000, 'new', NULL, 0, 0, ${T - 7 * DAY}, ${T}),
    ('p_kurta', 'Kurta Set', NULL, 150000, 'kurta-set', 'cat_men', NULL, 1, NULL, 0, 0, NULL, NULL, 1, 0, ${T - 6 * DAY}, ${T}),
    ('p_saree', 'Jamdani Saree', '<p>Handwoven.</p>', 900000, 'jamdani-saree', 'cat_saree', 'brd_aarong01', 1, NULL, 0, 0, 'new', NULL, 0, 1, ${T - 5 * DAY}, ${T}),
    ('p_shoe', 'Loafer', '<p>Leather.</p>', 320000, 'loafer', 'cat_acc', 'brd_yellow01', 1, NULL, 0, 0, 'used', NULL, 0, 0, ${T - 4 * DAY}, ${T}),
    ('p_bag', 'Tote Bag', '<p>Jute tote.</p>', 90000, 'tote-bag', 'cat_acc', NULL, 1, NULL, 0, 0, NULL, NULL, 0, 0, ${T - 3 * DAY}, ${T}),
    ('p_watch', 'Field Watch', NULL, 750000, 'field-watch', 'cat_internal', 'brd_yellow01', 1, NULL, 0, 0, NULL, NULL, 0, 0, ${T - 2 * DAY}, ${T}),
    ('p_draft', 'Draft Item', NULL, 100000, 'draft-item', 'cat_panjabi', NULL, 0, NULL, 0, 0, NULL, NULL, 0, 0, ${T - 1 * DAY}, ${T}),
    ('p_gift', 'Gift Card', NULL, 100000, 'gift-card', NULL, NULL, 1, NULL, 0, 0, NULL, NULL, 0, 0, ${T}, ${T});

  INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping) VALUES
    ('opt_linen_size', 'p_linen', 'Size', 'size', 0, 'size'),
    ('opt_silk_size', 'p_silk', 'Size', 'size', 0, 'size'),
    ('opt_silk_color', 'p_silk', 'Colour', 'colour', 1, 'color'),
    ('opt_shoe_size', 'p_shoe', 'Size', 'size', 0, 'size');
  INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
    ('ov_linen_m', 'opt_linen_size', 'M', 'm', 0), ('ov_linen_l', 'opt_linen_size', 'L', 'l', 1), ('ov_linen_xl', 'opt_linen_size', 'XL', 'xl', 2),
    ('ov_silk_m', 'opt_silk_size', 'M', 'm', 0), ('ov_silk_l', 'opt_silk_size', 'L', 'l', 1),
    ('ov_silk_gold', 'opt_silk_color', 'Gold', 'gold', 0), ('ov_silk_ivory', 'opt_silk_color', 'Ivory', 'ivory', 1),
    ('ov_shoe_41', 'opt_shoe_size', '41', '41', 0), ('ov_shoe_42', 'opt_shoe_size', '42', '42', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, option_combination_key, low_stock_threshold, barcode, barcode_type, image_id) VALUES
    ('v_linen_m', 'p_linen', 'LIN-M', 250000, 5, 0, 0, 1, 'M', NULL, '2000000000015', 'ean13', NULL),
    ('v_linen_l', 'p_linen', 'LIN-L', 260000, 2, 1, 0, 1, 'L', 3, NULL, NULL, NULL),
    ('v_linen_xl', 'p_linen', 'LIN-XL', 260000, 0, 0, 0, 1, 'XL', NULL, NULL, NULL, NULL),
    ('v_cotton', 'p_cotton', 'COT-1', 180000, 12, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
    ('v_silk_m_gold', 'p_silk', 'SILK-M-G', 520000, 4, 0, 0, 1, 'M|Gold', 2, NULL, NULL, NULL),
    ('v_silk_l_gold', 'p_silk', 'SILK-L-G', 540000, 1, 0, 0, 1, 'L|Gold', NULL, NULL, NULL, NULL),
    ('v_silk_m_ivory', 'p_silk', 'SILK-M-I', 520000, 9, 0, 0, 1, 'M|Ivory', NULL, NULL, NULL, NULL),
    ('v_kurta', 'p_kurta', 'KUR-1', 150000, 0, 0, 1, 0, NULL, NULL, NULL, NULL, NULL),
    ('v_saree', 'p_saree', 'SAR-1', 900000, 3, 0, 1, 1, NULL, 5, NULL, NULL, NULL),
    ('v_shoe_41', 'p_shoe', 'SHOE-41', 320000, 6, 0, 0, 1, '41', NULL, NULL, NULL, NULL),
    ('v_shoe_42', 'p_shoe', 'SHOE-42', 330000, 0, 0, 0, 1, '42', NULL, NULL, NULL, NULL),
    ('v_bag', 'p_bag', 'BAG-1', 90000, 40, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
    ('v_watch', 'p_watch', 'WAT-1', 750000, 2, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
    ('v_draft', 'p_draft', 'DRF-1', 100000, 2, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
    ('v_gift', 'p_gift', 'GIFT-1', 100000, 0, 0, 1, 0, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
    ('v_linen_m', 'opt_linen_size', 'ov_linen_m'), ('v_linen_l', 'opt_linen_size', 'ov_linen_l'), ('v_linen_xl', 'opt_linen_size', 'ov_linen_xl'),
    ('v_silk_m_gold', 'opt_silk_size', 'ov_silk_m'), ('v_silk_m_gold', 'opt_silk_color', 'ov_silk_gold'),
    ('v_silk_l_gold', 'opt_silk_size', 'ov_silk_l'), ('v_silk_l_gold', 'opt_silk_color', 'ov_silk_gold'),
    ('v_silk_m_ivory', 'opt_silk_size', 'ov_silk_m'), ('v_silk_m_ivory', 'opt_silk_color', 'ov_silk_ivory'),
    ('v_shoe_41', 'opt_shoe_size', 'ov_shoe_41'), ('v_shoe_42', 'opt_shoe_size', 'ov_shoe_42');
  INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order, alt_text) VALUES
    ('pmed_linen01', 'p_linen', 'media_linen', 1, 0, 'Linen front'),
    ('pmed_linen_02', 'p_linen', 'media_story', 0, 1, NULL),
    ('pmed_cotton01', 'p_cotton', 'media_cotton', 1, 0, NULL),
    ('pmed_silk001', 'p_silk', 'media_silk', 1, 0, NULL),
    ('pmed_saree01', 'p_saree', 'media_saree', 1, 0, NULL),
    ('pmed_shoe001', 'p_shoe', 'media_look', 1, 0, NULL),
    ('pmed_bag0001', 'p_bag', 'media_banner', 1, 0, NULL),
    ('pmed_watch01', 'p_watch', 'media_side', 1, 0, NULL);
  UPDATE product_variants SET image_id = 'pmed_linen_02' WHERE id = 'v_linen_l';
  INSERT INTO product_rich_content (id, product_id, title, content, sort_order) VALUES
    ('prc_care', 'p_linen', 'Care', '<p>Hand wash.</p>', 0),
    ('prc_fabric', 'p_silk', 'Fabric', '<p>Pure silk.</p>', 0);
  INSERT INTO product_content_blocks (id, product_id, placement, position, type, version, settings) VALUES
    ('pcb_promise', 'p_linen', 'after-buy-box', 0, 'guarantee', 1, '{"heading":"","text":"7-day returns."}'),
    ('pcb_silk', 'p_silk', 'after-buy-box', 0, 'guarantee', 1, '{"heading":"Promise","text":"Authentic silk."}');
  INSERT INTO product_bundles (id, product_id, quantity, discount_type, discount_bps, label, position, is_active) VALUES
    ('pbd_linen_pair', 'p_linen', 2, 'percentage', 1000, 'Pair', 0, 1),
    ('pbd_bag_three', 'p_bag', 3, 'percentage', 1500, NULL, 0, 1);

  INSERT INTO attribute_groups (id, name, sort_order) VALUES ('atg_specs001', 'Specifications', 0);
  INSERT INTO product_attributes (id, name, slug, filterable, group_id, value_type, sort_order, key_spec, highlight, facet_display) VALUES
    ('attr_material', 'Material', 'material', 1, 'atg_specs001', 'enum', 0, 1, 1, 'checkbox'),
    ('attr_weight', 'Weight', 'weight', 1, 'atg_specs001', 'number', 1, 0, 0, 'range'),
    ('attr_origin', 'Origin', 'origin', 0, NULL, 'text', 2, 0, 0, 'checkbox');
  INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order, swatch_hex) VALUES
    ('atv_linen001', 'attr_material', 'Linen', 'linen', 0, NULL),
    ('atv_cotton01', 'attr_material', 'Cotton', 'cotton', 1, NULL),
    ('atv_silk0001', 'attr_material', 'Silk', 'silk', 2, '#f5e6c8');
  INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_id, value_number) VALUES
    ('pav_linen_mat', 'p_linen', 'attr_material', 'Linen', 'atv_linen001', NULL),
    ('pav_cotton_mat', 'p_cotton', 'attr_material', 'Cotton', 'atv_cotton01', NULL),
    ('pav_silk_mat', 'p_silk', 'attr_material', 'Silk', 'atv_silk0001', NULL),
    ('pav_linen_wt', 'p_linen', 'attr_weight', '350', NULL, 350),
    ('pav_saree_org', 'p_saree', 'attr_origin', 'Dhaka', NULL, NULL);
  INSERT INTO category_attribute_sets (category_id, attribute_id, sort_order) VALUES
    ('cat_panjabi', 'attr_material', 0), ('cat_panjabi', 'attr_weight', 1), ('cat_men', 'attr_material', 0);

  INSERT INTO collections (id, name, presentation, config, sort_order, is_active, description, created_at, updated_at) VALUES
    ('col_manual', 'Best sellers', 'grid', ${q({ source: "manual", productIds: ["p_linen", "p_cotton", "p_saree"], featuredProductId: "p_linen", maxProducts: 8 })}, 0, 1, 'Our favourites', ${T}, ${T}),
    ('col_dynamic', 'Panjabi edit', 'carousel', ${q({ source: "dynamic", categoryIds: ["cat_panjabi"], maxProducts: 12 })}, 1, 1, NULL, ${T}, ${T}),
    ('col_hidden', 'Hidden', 'grid', ${q({ source: "manual", productIds: ["p_bag"], maxProducts: 4 })}, 2, 0, NULL, ${T}, ${T});

  INSERT INTO pages (id, title, slug, content, is_published, published_at, content_type, excerpt, tags, sort_order, created_at, updated_at) VALUES
    ('page_about', 'About us', 'about', '<p>We weave.</p>', 1, ${T - DAY}, 'page', NULL, '[]', 0, ${T}, ${T}),
    ('page_ship', 'Shipping policy', 'shipping-policy', '<p>2-3 days.</p>', 1, ${T - DAY}, 'page', NULL, '[]', 1, ${T}, ${T}),
    ('page_draft', 'Draft page', 'draft-page', '<p>Soon.</p>', 0, NULL, 'page', NULL, '[]', 2, ${T}, ${T}),
    ('art_eid', 'Eid lookbook', 'eid-lookbook', '<p>Festive picks.</p>', 1, ${T - 2 * DAY}, 'article', 'Festive picks', '["eid"]', 0, ${T}, ${T});

  INSERT INTO navigation_menus (id, name, handle, revision, published_revision) VALUES
    ('menu_main', 'Main', 'main', 1, 1), ('menu_footer', 'Footer', 'footer', 1, 1);
  INSERT INTO navigation_menu_publications (menu_id, revision, item_count, checksum) VALUES
    ('menu_main', 1, 3, 'seed-main-1'), ('menu_footer', 1, 2, 'seed-footer-1');
  INSERT INTO navigation_menu_publication_items (menu_id, revision, item_id, parent_id, position, label, label_mode, target_type, target_id, target_value, target_query, open_in_new_tab, is_enabled) VALUES
    ('menu_main', 1, 'nav_men', NULL, 0, 'Men', 'resource', 'category', 'cat_men', NULL, NULL, 0, 1),
    ('menu_main', 1, 'nav_panjabi', 'nav_men', 0, 'Panjabi', 'custom', 'category', 'cat_panjabi', NULL, NULL, 0, 1),
    ('menu_main', 1, 'nav_sale', NULL, 1, 'Sale', 'custom', 'internal_path', NULL, '/collections/col_manual', NULL, 0, 1),
    ('menu_footer', 1, 'nav_about', NULL, 0, 'About', 'resource', 'page', 'page_about', NULL, NULL, 0, 1),
    ('menu_footer', 1, 'nav_ext', NULL, 1, 'Blog', 'custom', 'external_url', NULL, 'https://blog.example.com', NULL, 1, 1);
  INSERT INTO navigation_placements (id, surface, slot, position, menu_id, label_override, is_enabled) VALUES
    ('place_header', 'header', 'primary', 0, 'menu_main', NULL, 1),
    ('place_footer', 'footer', 'column', 0, 'menu_footer', 'Company', 1);

  INSERT INTO settings (id, key, value, type, category) VALUES
    ('set_seo', 'document', ${q({ homepageTitle: "Scalius Test Store", homepageMetaDescription: "Handmade clothing", socialImage: "", discovery: {}, returnPolicy: {} })}, 'json', 'seo'),
    ('set_business', 'document', ${q({ companyName: "Test Store", legalName: "Test Store Ltd", addressLine1: "Road 1", addressLine2: "", city: "Dhaka", stateRegion: "", postalCode: "1207", country: "Bangladesh", phone: "01700000000", email: "shop@example.com", taxId: "", invoicePrefix: "INV", invoiceFooterText: "", invoiceLogoUrl: "", socialLinks: [{ id: "facebook", label: "Facebook", url: "https://facebook.com/store" }] })}, 'json', 'business'),
    ('set_currency', 'document', ${q({ currencyCode: "BDT", currencySymbol: "৳" })}, 'json', 'currency'),
    ('set_checkout', 'document', ${q({ guestCheckoutEnabled: true, checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0 })}, 'json', 'checkout'),
    ('set_inventory', 'document', ${q({ defaultLowStockThreshold: 2 })}, 'json', 'inventory'),
    ('set_emi', 'document', ${q({ enabled: true, plans: [{ id: "city-6", provider: "City Bank", months: 6, feeBps: 300, minAmountMinor: 0 }] })}, 'json', 'emi'),
    ('set_policies', 'document', ${q({ returnPolicy: "7 days", privacyPolicy: "", termsOfService: "" })}, 'json', 'policies'),
    ('set_countries', 'document', ${q({ allowedCountries: ["BD"], allowedCountriesMode: "include" })}, 'json', 'customer_countries'),
    ('set_payment_methods', 'document', ${q({ cod: { enabled: true } })}, 'json', 'payment_methods'),
    ('set_customer_requests', 'document', ${q({})}, 'json', 'customer_requests');

  INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ${q(everySectionTheme())}, 1, ${T}, ${T});

  INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active, sort_order) VALUES
    ('loc_dhaka', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1, 0),
    ('loc_ctg', 'Chattogram', 'BD', 1, NULL, '{}', '{}', 1, 1),
    ('loc_mirpur', 'Mirpur', 'BD', 2, 'loc_dhaka', '{}', '{}', 1, 0),
    ('loc_gulshan', 'Gulshan', 'BD', 2, 'loc_dhaka', '{}', '{}', 1, 1),
    ('loc_mirpur10', 'Mirpur 10', 'BD', 3, 'loc_mirpur', '{}', '{}', 1, 0);
  INSERT INTO delivery_zones (id, name, sort_order) VALUES ('zone_dhaka', 'Inside Dhaka', 0), ('zone_ctg', 'Chattogram', 1),
    ('zone_bd', 'Bangladesh', 2), ('zone_us', 'United States', 3), ('zone_west', 'West coast', 4);
  INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('loc_dhaka', 'zone_dhaka'), ('loc_ctg', 'zone_ctg');
  -- Zones by region (MARKETS-DESIGN step 3b): the rest of Bangladesh, the United States, and a part of it.
  INSERT INTO delivery_zone_regions (country_code, admin_area, postal_prefix, zone_id) VALUES
    ('BD', '', '', 'zone_bd'), ('US', '', '', 'zone_us'), ('US', 'CA', '', 'zone_west'), ('US', '', '97', 'zone_west');
  INSERT INTO shipping_methods (id, name, description, is_active, sort_order, fee_minor, zone_id, free_over_minor, kind) VALUES
    ('ship_dhaka', 'Inside Dhaka', '1-2 days', 1, 0, 6000, 'zone_dhaka', 150000, 'delivery'),
    ('ship_ctg', 'Chattogram', NULL, 1, 1, 12000, 'zone_ctg', NULL, 'delivery'),
    ('ship_bd', 'Outside Dhaka', NULL, 1, 2, 15000, 'zone_bd', NULL, 'delivery'),
    ('ship_us', 'US standard', NULL, 1, 3, 250000, 'zone_us', NULL, 'delivery'),
    ('ship_west', 'West coast', NULL, 1, 4, 150000, 'zone_west', 500000, 'delivery');

  INSERT INTO tax_classes (id, name, description, is_exempt) VALUES ('tax_std', 'Standard', NULL, 0), ('tax_zero', 'Zero rated', NULL, 1);
  INSERT INTO tax_regions (id, country_code, admin_area, postal_prefix, place_type, place_id, provider_id) VALUES
    ('txreg_bd', 'BD', '', '', NULL, NULL, NULL),
    ('txreg_bd_loc_dhaka', 'BD', '', '', 'city', 'loc_dhaka', NULL),
    ('txreg_us', 'US', '', '', NULL, NULL, NULL),
    ('txreg_us_ca', 'US', 'CA', '', NULL, NULL, NULL);
  INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps, priority, is_compound, combinable, is_active) VALUES
    ('rate_vat', 'tax_std', 'txreg_bd', 'VAT', 750, 0, 0, 0, 1),
    ('rate_dhaka', 'tax_std', 'txreg_bd_loc_dhaka', 'Dhaka surcharge', 100, 1, 0, 1, 1),
    ('rate_ca', 'tax_std', 'txreg_us_ca', 'California', 725, 0, 0, 0, 1);
  INSERT INTO tax_settings (id, enabled, tax_shipping, default_tax_class_id, shipping_tax_class_id, display_label) VALUES
    ('default', 1, 0, 'tax_std', NULL, 'VAT');
  UPDATE markets SET prices_include_tax = 1 WHERE is_backup = 1;

  -- Markets beside the migration's backup market (BD at the root): an active
  -- market at a subfolder and a draft one, so the generator edits each kind.
  INSERT INTO markets (id, handle, name, status, is_backup, price_increment_minor, revision, created_at, updated_at) VALUES
    ('mkt_dvc_india', 'india', 'India', 'active', 0, NULL, 1, ${T}, ${T}),
    ('mkt_dvc_draft', 'pakistan', 'Pakistan', 'draft', 0, NULL, 1, ${T}, ${T});
  INSERT INTO market_countries (country_code, market_id, created_at) VALUES
    ('IN', 'mkt_dvc_india', ${T}), ('NP', 'mkt_dvc_india', ${T}), ('PK', 'mkt_dvc_draft', ${T});
  INSERT INTO market_presences (id, market_id, kind, value, locale, created_at) VALUES
    ('mkp_dvc_india', 'mkt_dvc_india', 'subfolder', 'en-in', 'en', ${T}),
    ('mkp_dvc_draft', 'mkt_dvc_draft', 'subfolder', 'en-pk', 'en', ${T});

  INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES ('cus_1', 'Rahim', '01700000001', ${T}, ${T});
  INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at, customer_id) VALUES
    ('o_1', 'A', '01700000001', 'Road', 'city', 'zone', 'delivered', ${T - DAY}, ${T - DAY}, 'cus_1'),
    ('o_2', 'B', '01700000002', 'Road', 'city', 'zone', 'pending', ${T - DAY}, ${T - DAY}, NULL);
  INSERT INTO order_items (id, order_id, product_id, quantity, fulfilled_quantity) VALUES
    ('oi_1', 'o_1', 'p_linen', 1, 1), ('oi_2', 'o_2', 'p_linen', 1, 0), ('oi_3', 'o_1', 'p_cotton', 2, 2),
    -- Delivered lines nobody reviewed yet: a new review (insert) has a line to attach to.
    ('oi_4', 'o_1', 'p_linen', 1, 1), ('oi_5', 'o_1', 'p_cotton', 1, 1), ('oi_6', 'o_1', 'p_cotton', 1, 1);

  -- Reviews of the delivered order's lines (the stats rows come from the review triggers).
  INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, customer_id, author_type, author_display_name, rating, title, body, status, published_at, created_at, updated_at) VALUES
    ('rev_linen_0001', 'p_linen', NULL, 'o_1', 'oi_1', 'rk_cus_1', 'cus_1', 'customer', 'Rahim', 5, 'Lovely', 'Soft linen.', 'published', ${T - DAY / 2}, ${T}, ${T}),
    ('rev_cotton_001', 'p_cotton', NULL, 'o_1', 'oi_3', 'rk_cus_1', 'cus_1', 'customer', 'Rahim', 4, NULL, 'Good fit.', 'published', ${T - DAY / 2}, ${T}, ${T});
  -- Held by the automatic check: pending, never public until published.
  INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, customer_id, author_type, author_display_name, rating, title, body, status, check_flags, created_at, updated_at) VALUES
    ('rev_cotton_002', 'p_cotton', NULL, 'o_1', 'oi_6', 'rk_guest_1', NULL, 'guest_receipt', 'Guest', 2, NULL, 'See my site.', 'pending', '["url"]', ${T}, ${T});

  INSERT INTO warranty_policies (id, name, provider, duration_value, duration_unit, replacement_days, terms, current_revision_id, created_at, updated_at) VALUES
    ('wrp_brand_0001', 'Brand warranty', 'brand', 1, 'years', 7, 'Covers manufacturing defects.', 'wrr_brand_0001', ${T}, ${T}),
    ('wrp_store_0001', 'Store warranty', 'store', 30, 'days', NULL, NULL, 'wrr_store_0001', ${T}, ${T});
  INSERT INTO warranty_policy_revisions (id, policy_id, revision, name, provider, duration_value, duration_unit, replacement_days, terms, created_at) VALUES
    ('wrr_brand_0001', 'wrp_brand_0001', 1, 'Brand warranty', 'brand', 1, 'years', 7, 'Covers manufacturing defects.', ${T}),
    ('wrr_store_0001', 'wrp_store_0001', 1, 'Store warranty', 'store', 30, 'days', NULL, NULL, ${T});
  UPDATE products SET warranty_policy_id = 'wrp_brand_0001' WHERE id IN ('p_shoe', 'p_watch');
  UPDATE products SET warranty_policy_id = 'wrp_store_0001' WHERE id = 'p_bag';

  INSERT INTO promotions (id, name, title, method, status, priority, starts_at, ends_at, max_redemptions) VALUES
    ('promo_bxgy', 'Eid: buy 2 linen get a tote', 'Eid offer', 'automatic', 'active', 10, ${promoStart}, ${promoEnd}, NULL),
    ('promo_now', 'Always on: silk 10%', NULL, 'automatic', 'active', 20, NULL, ${DVC_IDS.promotionBoundaries[3]}, NULL),
    ('promo_code', 'Code SAVE10', NULL, 'code', 'active', 30, NULL, NULL, 100),
    ('promo_later', 'Later sale', NULL, 'automatic', 'active', 40, ${DVC_IDS.promotionBoundaries[1]}, NULL, NULL);
  INSERT INTO promotion_codes (id, promotion_id, code, normalized_code, is_active) VALUES ('pcode_save10', 'promo_code', 'SAVE10', 'SAVE10', 1);
  INSERT INTO promotion_conditions (id, promotion_id, kind, config, position) VALUES
    ('pcond_min', 'promo_code', 'minimum_merchandise_subtotal', ${q({ amountMinor: 100000, currencyCode: "BDT" })}, 0);
  INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position) VALUES
    ('peff_bxgy', 'promo_bxgy', 'percentage_off', 'line', 'across', ${q({ basisPoints: 10000, productIds: ["p_bag"], buy: { quantity: 2, productIds: ["p_linen"] }, getQuantity: 1 })}, 0),
    ('peff_now', 'promo_now', 'percentage_off', 'line', 'across', ${q({ basisPoints: 1000, productIds: ["p_bag"], buy: { quantity: 1, productIds: ["p_silk"] } })}, 0),
    ('peff_code', 'promo_code', 'percentage_off', 'order', 'once', ${q({ basisPoints: 1000 })}, 0),
    ('peff_later', 'promo_later', 'percentage_off', 'line', 'across', ${q({ basisPoints: 2000, productIds: ["p_cotton"], buy: { quantity: 1, productIds: ["p_shoe"] } })}, 0);
  INSERT INTO order_discount_allocations (id, order_id, order_item_id, promotion_id, effect_id, promotion_revision, evaluator_version, method, promotion_name, promotion_code, effect_kind, target, currency_code, base_amount_minor, discount_amount_minor, quantity) VALUES
    ('oda_1', 'o_1', 'oi_1', 'promo_code', 'peff_code', 1, 1, 'code', 'Code SAVE10', 'SAVE10', 'percentage_off', 'order', 'BDT', 10000, 1000, 1);
  INSERT INTO promotion_redemptions (id, promotion_id, order_id, customer_id, promotion_revision, promotion_code, currency_code, discount_amount_minor) VALUES
    ('pred_1', 'promo_code', 'o_1', 'cus_1', 1, 'SAVE10', 'BDT', 1000);
  -- A promotion limited to a customer segment: public offer reads skip it, so
  -- the generator's link inserts, re-points and deletes change what they list.
  INSERT INTO customer_segments (id, name, definition, created_at, updated_at) VALUES
    ('seg_dvc_vip01', 'VIP', ${q({ version: 1, match: "all", conditions: [{ field: "tags", op: "has_any", tags: ["vip"] }] })}, ${T}, ${T});
  INSERT INTO promotion_customer_segments (promotion_id, segment_id, created_at) VALUES ('promo_code', 'seg_dvc_vip01', ${T});

  -- Price lists (0120): the India market derives its prices by FX (+5 %, up to
  -- 10 taka, ending in 9) and has an active market list (with a quantity
  -- break), a sale between two scheduled boundaries and a draft, so the
  -- generator edits each kind and its presence reads are priced. The segment
  -- list prices the backup market, which is never deleted: a deleted India
  -- market (its lists cascade) still leaves rows to update and clone.
  UPDATE markets SET price_mode = 'fx', price_adjustment_bps = 500, price_rounding_minor = 1000, price_ending_minor = 900, fx_rate = '1' WHERE id = 'mkt_dvc_india';
  UPDATE markets SET fx_rate = '1.25' WHERE id = 'mkt_dvc_draft';
  INSERT INTO price_lists (id, name, kind, market_id, segment_id, status, starts_at, ends_at, priority, created_at, updated_at) VALUES
    ('pl_dvc_india', 'India retail', 'market', 'mkt_dvc_india', NULL, 'active', NULL, NULL, 1, ${T}, ${T}),
    ('pl_dvc_sale', 'India Eid sale', 'sale', 'mkt_dvc_india', NULL, 'active', ${DVC_IDS.promotionBoundaries[0]}, ${DVC_IDS.promotionBoundaries[1]}, 0, ${T}, ${T}),
    ('pl_dvc_draft', 'Draft prices', 'market', 'mkt_dvc_india', NULL, 'draft', NULL, NULL, 0, ${T}, ${T}),
    ('pl_dvc_vip', 'VIP wholesale', 'segment', 'mkt_backup', 'seg_dvc_vip01', 'active', NULL, NULL, 0, ${T}, ${T});
  INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor, compare_at_minor, min_quantity, created_at, updated_at) VALUES
    ('pl_dvc_india', 'v_linen_m', 'BDT', 240000, 260000, 1, ${T}, ${T}),
    ('pl_dvc_india', 'v_linen_m', 'BDT', 230000, NULL, 5, ${T}, ${T}),
    ('pl_dvc_india', 'v_cotton', 'BDT', 170000, NULL, 1, ${T}, ${T}),
    ('pl_dvc_india', 'v_bag', 'BDT', 85000, NULL, 1, ${T}, ${T}),
    ('pl_dvc_sale', 'v_silk_m_gold', 'BDT', 480000, NULL, 1, ${T}, ${T}),
    ('pl_dvc_draft', 'v_saree', 'BDT', 800000, NULL, 1, ${T}, ${T}),
    ('pl_dvc_vip', 'v_watch', 'BDT', 700000, NULL, 1, ${T}, ${T}),
    ('pl_dvc_vip', 'v_cotton', 'BDT', 160000, NULL, 1, ${T}, ${T}),
    ('pl_dvc_vip', 'v_bag', 'BDT', 80000, NULL, 3, ${T}, ${T});

  -- Sales channels (0122): the loafer is off the feeds and AI agents (the old
  -- feed flag), the cotton panjabi is off the Meta feed, and a second
  -- location holds two totes the Meta feed does not sell from, so the
  -- generator publishes, unpublishes and links locations over every read.
  UPDATE product_channel_publications SET unpublished_at = ${T} WHERE product_id = 'p_shoe' AND channel_id IN ('sc_google', 'sc_meta', 'sc_agents');
  UPDATE product_channel_publications SET unpublished_at = ${T} WHERE product_id = 'p_cotton' AND channel_id = 'sc_meta';
  INSERT INTO inventory_locations (id, name, code, country_code, is_default, status, position) VALUES ('loc_dvc_dhk', 'Dhaka shop', 'DHK', 'BD', 0, 'active', 1);
  UPDATE inventory_levels SET on_hand = on_hand - 2 WHERE variant_id = 'v_bag' AND location_id = 'loc_default';
  INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ('v_bag', 'loc_dvc_dhk', 2);
  DELETE FROM sales_channel_locations WHERE channel_id = 'sc_meta' AND location_id = 'loc_dvc_dhk';

  INSERT INTO checkout_languages (id, name, code, is_active, is_default, language_data, field_visibility) VALUES
    ('lang_en', 'English', 'en', 1, 1, ${q({ pageTitle: "Checkout", placeOrder: "Place order" })}, ${q({ email: true })}),
    ('lang_bn', 'Bangla', 'bn', 0, 0, ${q({ pageTitle: "চেকআউট" })}, ${q({})});
  INSERT INTO analytics (id, name, type, is_active, use_partytown, config, location) VALUES
    ('an_gtm', 'Tag Manager', 'custom', 1, 0, ${q({ script: "<script>window.dataLayer=[]</script>" })}, 'head');

  -- Custom fields (COMMERCE-HOOKS H4): storefront-visible fields of every public
  -- owner type, a hidden product field and a customer field buyers never see.
  INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type, validations, storefront_visible, position, created_at, updated_at) VALUES
    ('cfd_care_0001', 'product', 'custom', 'care_guide', 'Care guide', 'multi_line_text', '{}', 1, 0, ${T}, ${T}),
    ('cfd_msrp_0001', 'product', 'custom', 'msrp', 'MSRP', 'money', '{}', 1, 1, ${T}, ${T}),
    ('cfd_cost_0001', 'product', 'custom', 'cost_note', 'Cost note', 'single_line_text', '{}', 0, 2, ${T}, ${T}),
    ('cfd_fit_00001', 'variant', 'custom', 'fit', 'Fit', 'single_line_text', '{}', 1, 0, ${T}, ${T}),
    ('cfd_banner_01', 'category', 'custom', 'banner_note', 'Banner note', 'single_line_text', '{}', 1, 0, ${T}, ${T}),
    ('cfd_season_01', 'collection', 'custom', 'season', 'Season', 'list.single_line_text', '{}', 1, 0, ${T}, ${T}),
    ('cfd_origin_01', 'brand', 'custom', 'origin', 'Origin', 'single_line_text', '{}', 1, 0, ${T}, ${T}),
    ('cfd_hero_0001', 'page', 'custom', 'hero_colour', 'Hero colour', 'color', '{}', 1, 0, ${T}, ${T}),
    ('cfd_vip_00001', 'customer', 'custom', 'vip', 'VIP', 'boolean', '{}', 0, 0, ${T}, ${T});
  INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value, updated_at) VALUES
    ('cfd_care_0001', 'product', 'p_linen', 'Hand wash cold.', ${T}),
    ('cfd_care_0001', 'product', 'p_cotton', 'Machine wash.', ${T}),
    ('cfd_msrp_0001', 'product', 'p_linen', '300000', ${T}),
    ('cfd_cost_0001', 'product', 'p_linen', 'Supplier A', ${T}),
    ('cfd_fit_00001', 'variant', 'v_linen_m', 'Regular', ${T}),
    ('cfd_banner_01', 'category', 'cat_panjabi', 'Eid edit', ${T}),
    ('cfd_season_01', 'collection', 'col_manual', '["Eid","Winter"]', ${T}),
    ('cfd_origin_01', 'brand', 'brd_aarong01', 'Bangladesh', ${T}),
    ('cfd_hero_0001', 'page', 'page_about', '#aa3300', ${T}),
    ('cfd_vip_00001', 'customer', 'cus_1', 'true', ${T});
  `;
}

/** Seed the store into a freshly migrated database, then build the projections a live store keeps. */
export async function seedDvcStore(sqlite: DatabaseSync, db: Database): Promise<void> {
  sqlite.exec(seedSql());
  sqlite.exec(pluginSeedSql());
  await rebuildCatalogProjections(db);
  await refreshProductSalesStats(db);
  await refreshProductRecommendations(db, [...DVC_IDS.products]);
}
