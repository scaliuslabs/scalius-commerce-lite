/**
 * A small store that uses every buyer-visible table the DVC registry lists,
 * so the row-mutation generator has a real row to update, clone or delete in
 * each of them: a three-level category tree, brands, simple and optioned
 * products with media, attributes, facets, rich content, bundles, manual and
 * dynamic collections, CMS pages and articles, a published navigation, hero
 * slides, settings documents, a theme using every section type, shipping,
 * locations, tax, scheduled promotions, checkout languages, analytics,
 * reviews of a delivered order's lines and warranty policies.
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
  menus: ["menu_main", "menu_footer"],
  promotionBoundaries: [DVC_SEED_EPOCH + 3 * DAY, DVC_SEED_EPOCH + 5 * DAY, DVC_SEED_EPOCH + 9 * DAY, DVC_SEED_EPOCH + 12 * DAY],
} as const;

function everySectionTheme(): unknown {
  const theme = storefrontTemplateTheme("department-mall");
  const sections: StorefrontSection[] = STOREFRONT_SECTION_TYPES.map((type, index) => storefrontSectionDefault(type, `s${index}`));
  const set = (type: string, settings: Record<string, unknown>, id = type) => {
    const section = { id, type, version: 1, settings } as StorefrontSection;
    const at = sections.findIndex((each) => each.type === type && each.id.startsWith("s"));
    if (at >= 0 && id === type) sections[at] = section;
    else sections.push(section);
  };
  set("hero", { layout: "contained-banners", sideBanners: [{ mediaId: "media_side", alt: "Side", href: "/sale" }] });
  set("product-rail", { title: "", source: { kind: "popular" }, limit: 12 });
  set("product-grid", { title: "", source: { kind: "category", categoryId: "cat_panjabi" }, columns: 4, rows: 2 });
  set("deal-block", { title: "", source: { kind: "on-sale" }, endsAt: null });
  set("lookbook", { title: "", mediaId: "media_look", source: { kind: "collection", collectionId: "col_manual" } });
  set("banner", { layout: "two-up", heading: "Eid", text: "", mediaId: "media_banner", cta: null });
  set("editorial", { layout: "image-with-text", heading: "Story", body: "Woven by hand.", mediaId: "media_story", imageSide: "end" });
  set("product-rail", { title: "", source: { kind: "newest" }, limit: 8 }, "rail-newest");
  (theme as { pages: { home: StorefrontSection[] } }).pages.home = sections;
  return theme;
}

const slide = (id: string, key: string) => ({ id, url: `https://media.test/${key}`, title: id, heading: "", buttonLabel: "", link: "", focalPoint: { x: 50, y: 50 } });
const q = (value: unknown) => `'${(typeof value === "string" ? value : JSON.stringify(value)).replace(/'/g, "''")}'`;
const T = DVC_SEED_EPOCH;

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

  INSERT INTO products (id, name, description, price_minor, slug, category_id, brand_id, is_active, discount_type, discount_bps, discount_amount_minor, product_condition, meta_title, no_index, exclude_from_sitemap, exclude_from_product_feed, created_at, updated_at) VALUES
    ('p_linen', 'Linen Panjabi', '<p>Breathable linen.</p>', 250000, 'linen-panjabi', 'cat_panjabi', 'brd_aarong01', 1, NULL, 0, 0, 'new', 'Linen Panjabi | Store', 0, 0, 0, ${T - 9 * DAY}, ${T}),
    ('p_cotton', 'Cotton Panjabi', '<p>Soft cotton.</p>', 180000, 'cotton-panjabi', 'cat_panjabi', 'brd_yellow01', 1, 'percentage', 1000, 0, 'new', NULL, 0, 0, 0, ${T - 8 * DAY}, ${T}),
    ('p_silk', 'Silk Panjabi', '<p>Silk for Eid.</p>', 520000, 'silk-panjabi', 'cat_festive', 'brd_aarong01', 1, 'fixed', 0, 20000, 'new', NULL, 0, 0, 0, ${T - 7 * DAY}, ${T}),
    ('p_kurta', 'Kurta Set', NULL, 150000, 'kurta-set', 'cat_men', NULL, 1, NULL, 0, 0, NULL, NULL, 1, 0, 0, ${T - 6 * DAY}, ${T}),
    ('p_saree', 'Jamdani Saree', '<p>Handwoven.</p>', 900000, 'jamdani-saree', 'cat_saree', 'brd_aarong01', 1, NULL, 0, 0, 'new', NULL, 0, 1, 0, ${T - 5 * DAY}, ${T}),
    ('p_shoe', 'Loafer', '<p>Leather.</p>', 320000, 'loafer', 'cat_acc', 'brd_yellow01', 1, NULL, 0, 0, 'used', NULL, 0, 0, 1, ${T - 4 * DAY}, ${T}),
    ('p_bag', 'Tote Bag', '<p>Jute tote.</p>', 90000, 'tote-bag', 'cat_acc', NULL, 1, NULL, 0, 0, NULL, NULL, 0, 0, 0, ${T - 3 * DAY}, ${T}),
    ('p_watch', 'Field Watch', NULL, 750000, 'field-watch', 'cat_internal', 'brd_yellow01', 1, NULL, 0, 0, NULL, NULL, 0, 0, 0, ${T - 2 * DAY}, ${T}),
    ('p_draft', 'Draft Item', NULL, 100000, 'draft-item', 'cat_panjabi', NULL, 0, NULL, 0, 0, NULL, NULL, 0, 0, 0, ${T - 1 * DAY}, ${T}),
    ('p_gift', 'Gift Card', NULL, 100000, 'gift-card', NULL, NULL, 1, NULL, 0, 0, NULL, NULL, 0, 0, 0, ${T}, ${T});

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
    ('col_manual', 'Best sellers', 'grid', ${q({ source: "manual", productIds: ["p_linen", "p_cotton", "p_saree"], showOnHomepage: true, featuredProductId: "p_linen", maxProducts: 8 })}, 0, 1, 'Our favourites', ${T}, ${T}),
    ('col_dynamic', 'Panjabi edit', 'carousel', ${q({ source: "dynamic", categoryIds: ["cat_panjabi"], showOnHomepage: true, maxProducts: 12 })}, 1, 1, NULL, ${T}, ${T}),
    ('col_hidden', 'Hidden', 'grid', ${q({ source: "manual", productIds: ["p_bag"], showOnHomepage: false, maxProducts: 4 })}, 2, 0, NULL, ${T}, ${T});

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

  INSERT INTO hero_sliders (id, type, images, is_active) VALUES
    ('hero_desktop', 'desktop', ${q([slide("d1", "media/hero.jpg"), slide("d2", "media/side.jpg")])}, 1),
    ('hero_mobile', 'mobile', ${q([slide("m1", "media/hero.jpg")])}, 1);

  INSERT INTO settings (id, key, value, type, category) VALUES
    ('set_seo', 'document', ${q({ homepageTitle: "Scalius Test Store", homepageMetaDescription: "Handmade clothing", socialImage: "", discovery: {}, returnPolicy: {} })}, 'json', 'seo'),
    ('set_business', 'document', ${q({ companyName: "Test Store", legalName: "Test Store Ltd", addressLine1: "Road 1", addressLine2: "", city: "Dhaka", stateRegion: "", postalCode: "1207", country: "Bangladesh", phone: "01700000000", email: "shop@example.com", taxId: "", invoicePrefix: "INV", invoiceFooterText: "", invoiceLogoUrl: "" })}, 'json', 'business'),
    ('set_currency', 'document', ${q({ currencyCode: "BDT", currencySymbol: "৳", usdExchangeRate: "120" })}, 'json', 'currency'),
    ('set_homepage', 'document', ${q({ categoryRail: { enabled: true, title: "Shop by category", categoryIds: ["cat_panjabi", "cat_saree"] }, trustStrip: { enabled: true } })}, 'json', 'homepage'),
    ('set_header', 'document', ${q({ logo: { src: "https://media.test/media/logo.png", alt: "Store" }, contact: { phone: "01700000000" } })}, 'json', 'header'),
    ('set_footer', 'document', ${q({ tagline: "Handmade", description: "Since 1978", copyrightText: "(c) Store", social: [{ platform: "facebook", url: "https://facebook.com/store" }] })}, 'json', 'footer'),
    ('set_checkout', 'document', ${q({ guestCheckoutEnabled: true, checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0 })}, 'json', 'checkout'),
    ('set_inventory', 'document', ${q({ defaultLowStockThreshold: 2 })}, 'json', 'inventory'),
    ('set_emi', 'document', ${q({ enabled: true, plans: [{ id: "city-6", provider: "City Bank", months: 6, feeBps: 300, minAmountMinor: 0 }] })}, 'json', 'emi'),
    ('set_policies', 'document', ${q({ returnPolicy: "7 days", privacyPolicy: "", termsOfService: "" })}, 'json', 'policies'),
    ('set_countries', 'document', ${q({ allowedCountries: ["BD"], allowedCountriesMode: "include" })}, 'json', 'customer_countries'),
    ('set_payment_methods', 'document', ${q({ cod: { enabled: true } })}, 'json', 'payment_methods'),
    ('set_customer_requests', 'document', ${q({})}, 'json', 'customer_requests');

  INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ${q(everySectionTheme())}, 1, ${T}, ${T});

  INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active, sort_order) VALUES
    ('loc_dhaka', 'Dhaka', 'city', NULL, '{}', '{}', 1, 0),
    ('loc_ctg', 'Chattogram', 'city', NULL, '{}', '{}', 1, 1),
    ('loc_mirpur', 'Mirpur', 'zone', 'loc_dhaka', '{}', '{}', 1, 0),
    ('loc_gulshan', 'Gulshan', 'zone', 'loc_dhaka', '{}', '{}', 1, 1),
    ('loc_mirpur10', 'Mirpur 10', 'area', 'loc_mirpur', '{}', '{}', 1, 0);
  INSERT INTO delivery_zones (id, name, sort_order) VALUES ('zone_dhaka', 'Inside Dhaka', 0), ('zone_ctg', 'Chattogram', 1);
  INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('loc_dhaka', 'zone_dhaka'), ('loc_ctg', 'zone_ctg');
  INSERT INTO shipping_methods (id, name, description, is_active, sort_order, fee_minor, zone_id, free_over_minor, kind) VALUES
    ('ship_dhaka', 'Inside Dhaka', '1-2 days', 1, 0, 6000, 'zone_dhaka', 150000, 'delivery'),
    ('ship_ctg', 'Chattogram', NULL, 1, 1, 12000, 'zone_ctg', NULL, 'delivery');

  INSERT INTO tax_classes (id, name, description, is_exempt) VALUES ('tax_std', 'Standard', NULL, 0), ('tax_zero', 'Zero rated', NULL, 1);
  INSERT INTO tax_rates (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id, jurisdiction_label, priority, is_compound, is_active) VALUES
    ('rate_vat', 'tax_std', 'VAT', 750, 'all', NULL, NULL, 0, 0, 1),
    ('rate_dhaka', 'tax_std', 'Dhaka surcharge', 100, 'city', 'loc_dhaka', 'Dhaka', 1, 0, 1);
  INSERT INTO tax_settings (id, enabled, prices_include_tax, tax_shipping, default_tax_class_id, shipping_tax_class_id, display_label) VALUES
    ('default', 1, 1, 0, 'tax_std', NULL, 'VAT');

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

  INSERT INTO checkout_languages (id, name, code, is_active, is_default, language_data, field_visibility) VALUES
    ('lang_en', 'English', 'en', 1, 1, ${q({ pageTitle: "Checkout", placeOrder: "Place order" })}, ${q({ email: true })}),
    ('lang_bn', 'Bangla', 'bn', 0, 0, ${q({ pageTitle: "চেকআউট" })}, ${q({})});
  INSERT INTO analytics (id, name, type, is_active, use_partytown, config, location) VALUES
    ('an_gtm', 'Tag Manager', 'custom', 1, 0, ${q({ script: "<script>window.dataLayer=[]</script>" })}, 'head');
  `;
}

/** Seed the store into a freshly migrated database, then build the projections a live store keeps. */
export async function seedDvcStore(sqlite: DatabaseSync, db: Database): Promise<void> {
  sqlite.exec(seedSql());
  await rebuildCatalogProjections(db);
  await refreshProductSalesStats(db);
  await refreshProductRecommendations(db, [...DVC_IDS.products]);
}
