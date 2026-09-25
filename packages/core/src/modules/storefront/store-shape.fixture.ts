// A small category tree for the store shape tests (SQLite and PostgreSQL):
// reachable and unreachable branches, brands, public and inactive products.
//
// Tree (status in brackets, * holds a public product):
//   A [pub]  - A1 [pub] - A1a [pub]* - A1a1 [pub]
//                        - A1b [pub]
//            - A2 [draft] - A2a [pub] - A2a1 [pub]*   (hidden ancestor)
//            - A3 [pub] - A3a [pub], A3b [pub]
//   B [pub]  (only an inactive product)
//   C [draft] - C1 [pub]*
//   E [pub]  - E1 [draft]*                           (draft subtree)
//   F [pub]*
export const STORE_SHAPE_TREE = [
  `INSERT INTO categories (id, name, slug, status, parent_id) VALUES
    ('A', 'A', 'a', 'published', NULL), ('B', 'B', 'b', 'published', NULL), ('C', 'C', 'c', 'draft', NULL),
    ('E', 'E', 'e', 'published', NULL), ('F', 'F', 'f', 'published', NULL)`,
  `INSERT INTO categories (id, name, slug, status, parent_id) VALUES
    ('A1', 'A1', 'a1', 'published', 'A'), ('A2', 'A2', 'a2', 'draft', 'A'), ('A3', 'A3', 'a3', 'published', 'A'),
    ('C1', 'C1', 'c1', 'published', 'C'), ('E1', 'E1', 'e1', 'draft', 'E')`,
  `INSERT INTO categories (id, name, slug, status, parent_id) VALUES
    ('A1a', 'A1a', 'a1a', 'published', 'A1'), ('A1b', 'A1b', 'a1b', 'published', 'A1'),
    ('A2a', 'A2a', 'a2a', 'published', 'A2'), ('A3a', 'A3a', 'a3a', 'published', 'A3'), ('A3b', 'A3b', 'a3b', 'published', 'A3')`,
  `INSERT INTO categories (id, name, slug, status, parent_id) VALUES
    ('A1a1', 'A1a1', 'a1a1', 'published', 'A1a'), ('A2a1', 'A2a1', 'a2a1', 'published', 'A2a')`,
  `INSERT INTO brands (id, name, slug, status) VALUES
    ('brd_public', 'Public', 'public', 'published'), ('brd_hidden', 'Draft', 'draft', 'draft'),
    ('brd_unused', 'Empty', 'empty', 'published')`,
];

const product = (id: string, categoryId: string, brandId: string | null = null, active = 1) => [
  `INSERT INTO products (id, name, price_minor, slug, is_active, category_id, brand_id)
    VALUES ('${id}', '${id}', 1000, '${id}', ${active}, '${categoryId}', ${brandId ? `'${brandId}'` : "NULL"})`,
  `INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
    VALUES ('v_${id}', '${id}', 'SKU-${id}', 1000, 3, 0, 1, 1)`,
];

/** The fixture's products, one statement per string. */
export const STORE_SHAPE_PRODUCTS = [
  ...product("p_a1a", "A1a", "brd_public"),
  ...product("p_a2a1", "A2a1", "brd_hidden"),
  ...product("p_c1", "C1"),
  ...product("p_e1", "E1"),
  ...product("p_f", "F"),
  ...product("p_off", "B", "brd_unused", 0),
];

/** What the shape reads on the fixture. */
export const STORE_SHAPE_EXPECTED = {
  productCount: 5,
  skuCount: 5,
  // A (A1a) and F; not B (inactive only), C (draft), E (only a draft child holds products).
  topCategoryCount: 2,
  // A1a is at depth 2; A2a1 (depth 3) sits under the draft A2.
  categoryDepth: 3,
  // A1 and A3 each have two published children under A.
  categoryGroups: 2,
  // Only the published brand with a public product.
  brandCount: 1,
  hasKeySpecs: false,
} as const;
