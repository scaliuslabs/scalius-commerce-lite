#!/usr/bin/env node
/**
 * catalog-scale-seed.mjs — deterministic large-catalogue seed for LOCAL load
 * and capacity tests (Startech/Applegadgets scale).
 *
 *   node scripts/catalog-scale-seed.mjs --state /tmp/catalog-scale/state
 *
 * Writes straight into the SQLite file of a local Miniflare D1 state
 * directory you own (apply migrations to it first with
 * `SCALIUS_WRANGLER_STATE=<dir> node scripts/deploy.mjs --migrate-only --local`),
 * with no Worker running against it. It never touches remote D1 and refuses the
 * shared repo `.wrangler/state`.
 *
 * Default shape (override with --products, --customers, --orders, --seed):
 * ~30k products (60% simple with one hidden default SKU, 40% optioned with one
 * or two merchant axes, a handful with 60-100 SKUs), ~80k SKUs with globally
 * unique SKU/barcode identity, a 400-category tree (25 roots x 5 second
 * levels x 1 x 1: four levels, trigger-maintained through `parent_id`), 300
 * published brand entities (`products.brand_id`, mirrored by a Brand
 * attribute) plus 30 spec attributes of which the headline ones are key specs,
 * 1-4 images per product as ready media rows, ledger-v2 stock edges for every
 * stocked SKU, 50 collections (manual and dynamic), 20k customers and 50k
 * orders. It ends by filling the catalogue projections (migration 0091's
 * idempotent statements), so the store's buyer state is complete.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

const statePath = arg("--state", null);
if (!statePath) {
  console.error("Usage: node scripts/catalog-scale-seed.mjs --state <local wrangler state dir> [--products 30000] [--customers 20000] [--orders 50000] [--seed 20260925]");
  process.exit(1);
}
const PRODUCTS = Number(arg("--products", "30000"));
const CUSTOMERS = Number(arg("--customers", "20000"));
const ORDERS = Number(arg("--orders", "50000"));
const SEED = Number(arg("--seed", "20260925"));
const CATEGORIES = 400;
const BRANDS = 300;
const COLLECTIONS = 50;

const resolvedState = realpathSync(resolve(statePath));
const sharedState = resolve(root, ".wrangler");
const mainCheckoutShared = resolve(root, "..", "..", "..", ".wrangler");
for (const forbidden of [sharedState, mainCheckoutShared]) {
  if (existsSync(forbidden) && resolvedState.startsWith(realpathSync(forbidden))) {
    console.error(`Refusing to seed the shared repo state at ${forbidden}. Use a state dir you own.`);
    process.exit(1);
  }
}
const d1Dir = join(resolvedState, "v3", "d1", "miniflare-D1DatabaseObject");
const dbFiles = existsSync(d1Dir)
  ? readdirSync(d1Dir).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
  : [];
if (dbFiles.length !== 1) {
  console.error(`Expected exactly one D1 sqlite file under ${d1Dir}; found ${dbFiles.length}. Apply local migrations first.`);
  process.exit(1);
}
const db = new DatabaseSync(join(d1Dir, dbFiles[0]));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
const existing = db.prepare("SELECT count(*) AS n FROM products").get().n;
if (existing > 0) {
  console.error(`products already has ${existing} rows; seed an empty migrated state.`);
  process.exit(1);
}

// ---------------------------------------------------------------- determinism
let rngState = SEED >>> 0;
function rand() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (p) => rand() < p;
const pad = (n, width) => String(n).padStart(width, "0");
function sample(list, count) {
  const copy = [...list];
  const out = [];
  while (out.length < count && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
const slugify = (value) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function ean13(n) {
  const body = `20${pad(n, 10)}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(body[i]) * (i % 2 ? 3 : 1);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

const NOW = 1790000000; // fixed epoch so the seed is byte-for-byte repeatable
const DAY = 86400;
const tx = (fn) => {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
const started = Date.now();
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);

// ---------------------------------------------------------------- vocabulary
const FAMILIES = [
  { name: "Laptop", axes: [["RAM", ["8GB", "16GB", "32GB"]], ["Storage", ["256GB SSD", "512GB SSD", "1TB SSD"]]], price: [45000, 350000], specs: ["Processor", "RAM", "Storage", "Display Size", "Graphics", "Operating System", "Warranty"] },
  { name: "Desktop PC", axes: [["RAM", ["8GB", "16GB", "32GB", "64GB"]]], price: [30000, 450000], specs: ["Processor", "RAM", "Storage", "Graphics", "Warranty"] },
  { name: "Monitor", axes: [["Size", ["24 inch", "27 inch", "32 inch"]]], price: [9000, 180000], specs: ["Display Size", "Resolution", "Refresh Rate", "Panel Type", "Warranty"] },
  { name: "Smartphone", axes: [["Storage", ["128GB", "256GB", "512GB", "1TB"]], ["Color", ["Black", "White", "Blue", "Green", "Titanium", "Gold"]]], price: [9000, 250000], specs: ["Chipset", "RAM", "Storage", "Display Size", "Battery", "Network", "Warranty"] },
  { name: "Tablet", axes: [["Storage", ["64GB", "128GB", "256GB"]], ["Color", ["Grey", "Silver", "Blue"]]], price: [15000, 200000], specs: ["Chipset", "RAM", "Storage", "Display Size", "Battery"] },
  { name: "Headphone", axes: [["Color", ["Black", "White", "Blue", "Red"]]], price: [900, 60000], specs: ["Connectivity", "Driver Size", "Battery", "Warranty"] },
  { name: "Earbuds", axes: [["Color", ["Black", "White", "Blue"]]], price: [1200, 35000], specs: ["Connectivity", "Battery", "Warranty"] },
  { name: "Keyboard", axes: [["Switch", ["Red", "Blue", "Brown"]]], price: [700, 25000], specs: ["Connectivity", "Layout", "Warranty"] },
  { name: "Mouse", axes: [["Color", ["Black", "White"]]], price: [400, 18000], specs: ["Connectivity", "DPI", "Warranty"] },
  { name: "Router", axes: [], price: [1500, 45000], specs: ["Wi-Fi Standard", "Ports", "Warranty"] },
  { name: "SSD", axes: [["Capacity", ["256GB", "512GB", "1TB", "2TB", "4TB"]]], price: [2500, 60000], specs: ["Interface", "Read Speed", "Warranty"] },
  { name: "Hard Disk", axes: [["Capacity", ["1TB", "2TB", "4TB", "8TB"]]], price: [4000, 40000], specs: ["Interface", "RPM", "Warranty"] },
  { name: "RAM", axes: [["Capacity", ["8GB", "16GB", "32GB"]]], price: [1800, 35000], specs: ["Memory Type", "Bus Speed", "Warranty"] },
  { name: "Graphics Card", axes: [], price: [15000, 350000], specs: ["Chipset", "Memory Type", "Warranty"] },
  { name: "Processor", axes: [], price: [6000, 120000], specs: ["Processor", "Socket", "Warranty"] },
  { name: "Motherboard", axes: [], price: [6000, 90000], specs: ["Socket", "Memory Type", "Warranty"] },
  { name: "Power Bank", axes: [["Color", ["Black", "White", "Blue"]]], price: [900, 9000], specs: ["Battery", "Ports", "Warranty"] },
  { name: "Smart Watch", axes: [["Size", ["41mm", "45mm", "49mm"]], ["Color", ["Black", "Silver", "Pink", "Green"]]], price: [1500, 120000], specs: ["Display Size", "Battery", "Connectivity", "Warranty"] },
  { name: "Camera", axes: [["Kit", ["Body Only", "With 18-55mm Lens", "With 18-135mm Lens"]]], price: [30000, 600000], specs: ["Sensor", "Resolution", "Warranty"] },
  { name: "Printer", axes: [], price: [8000, 150000], specs: ["Print Type", "Connectivity", "Warranty"] },
  { name: "UPS", axes: [["Capacity", ["650VA", "1200VA", "2000VA"]]], price: [3500, 80000], specs: ["Battery", "Warranty"] },
  { name: "Television", axes: [["Size", ["32 inch", "43 inch", "55 inch", "65 inch", "75 inch"]]], price: [15000, 500000], specs: ["Display Size", "Resolution", "Panel Type", "Operating System", "Warranty"] },
  { name: "Air Conditioner", axes: [["Capacity", ["1 Ton", "1.5 Ton", "2 Ton"]]], price: [40000, 180000], specs: ["Warranty", "Energy Rating"] },
  { name: "Refrigerator", axes: [], price: [25000, 250000], specs: ["Capacity Litres", "Energy Rating", "Warranty"] },
  { name: "Phone Case", axes: [["Model", ["iPhone 15", "iPhone 15 Pro", "iPhone 16", "iPhone 16 Pro", "iPhone 16 Pro Max", "Galaxy S24", "Galaxy S24 Ultra", "Galaxy S25", "Pixel 9", "Pixel 9 Pro"]], ["Color", ["Black", "Clear", "Blue", "Red", "Pink", "Green", "Purple", "Orange", "Yellow", "White"]]], price: [300, 4500], specs: ["Material", "Warranty"] },
];
const QUALIFIERS = ["Gaming", "Business", "Budget", "Premium", "Student", "Creator", "Ultra-thin", "2-in-1", "Wireless", "Pro", "Mini", "Refurbished", "Portable", "Smart", "Commercial", "Home"];
const BRAND_ROOTS = ["Asus", "Acer", "Lenovo", "HP", "Dell", "MSI", "Gigabyte", "Apple", "Samsung", "Xiaomi", "Realme", "OnePlus", "Oppo", "Vivo", "Walton", "Symphony", "Huawei", "Honor", "Infinix", "Tecno", "Nokia", "Sony", "LG", "Philips", "Panasonic", "Canon", "Nikon", "Fujifilm", "Epson", "Brother", "TP-Link", "Tenda", "D-Link", "Netgear", "Mercusys", "Logitech", "Razer", "Corsair", "HyperX", "SteelSeries", "Redragon", "Fantech", "A4Tech", "Rapoo", "Havit", "JBL", "Anker", "Baseus", "Ugreen", "Remax", "Kingston", "Crucial", "Western Digital", "Seagate", "Toshiba", "Transcend", "Adata", "Team", "Intel", "AMD", "Nvidia", "Zotac", "Sapphire", "PowerColor", "Colorful", "Antec", "Cooler Master", "Thermaltake", "DeepCool", "Lian Li", "NZXT", "Apollo", "Power Guard", "Maxgreen", "Gree", "General", "Midea", "Haier", "Singer", "Vision", "Minister", "Jamuna", "Transtec", "Hisense", "TCL", "Amazfit", "Garmin", "Kieslect", "Haylou", "QCY", "Edifier", "Microlab", "F&D", "Lenovo Legion", "Beats", "Bose", "Sennheiser", "Audio-Technica", "Spigen"];
const SERIES = ["Vivobook", "Zenbook", "TUF", "ROG", "Aspire", "Nitro", "Predator", "IdeaPad", "ThinkPad", "Legion", "Pavilion", "Victus", "Omen", "Inspiron", "Vostro", "Latitude", "Katana", "Galaxy", "Redmi", "Note", "Nord", "Reno", "Primo", "Hot", "Spark", "Camon", "Bravia", "OLED", "UltraGear", "Archer", "Deco", "MX", "G Pro", "BlackWidow", "Vengeance", "Fury", "Blue", "Barracuda", "Ryzen", "Core", "GeForce", "Radeon", "PowerCore", "Tune", "Flip", "Charge", "EOS", "Alpha", "PIXMA", "EcoTank"];
const SPEC_VALUES = {
  "Processor": ["Intel Core i3 1215U", "Intel Core i5 1335U", "Intel Core i5 13420H", "Intel Core i7 13620H", "Intel Core i7 14700HX", "Intel Core i9 14900HX", "Intel Core Ultra 5 125H", "Intel Core Ultra 7 155H", "AMD Ryzen 5 7520U", "AMD Ryzen 5 7535HS", "AMD Ryzen 7 7735HS", "AMD Ryzen 7 8845HS", "AMD Ryzen 9 7945HX", "Apple M3", "Apple M3 Pro", "Apple M4"],
  "RAM": ["4GB", "6GB", "8GB", "12GB", "16GB", "24GB", "32GB", "64GB"],
  "Storage": ["64GB", "128GB", "256GB", "512GB", "1TB", "2TB"],
  "Display Size": ["6.1 inch", "6.5 inch", "6.7 inch", "11 inch", "13.3 inch", "14 inch", "15.6 inch", "16 inch", "17.3 inch", "24 inch", "27 inch", "32 inch", "43 inch", "55 inch"],
  "Graphics": ["Integrated", "RTX 3050", "RTX 4050", "RTX 4060", "RTX 4070", "RTX 4080", "RTX 4090", "RX 7600S"],
  "Operating System": ["Windows 11 Home", "Windows 11 Pro", "FreeDOS", "macOS", "Android", "Google TV", "Tizen", "webOS"],
  "Warranty": ["No Warranty", "6 Months", "1 Year", "2 Years", "3 Years", "5 Years"],
  "Resolution": ["HD", "FHD 1080p", "QHD 1440p", "4K UHD", "5K", "8K", "24MP", "33MP", "45MP"],
  "Refresh Rate": ["60Hz", "75Hz", "100Hz", "120Hz", "144Hz", "165Hz", "180Hz", "240Hz", "360Hz"],
  "Panel Type": ["IPS", "VA", "TN", "OLED", "QLED", "Mini LED"],
  "Chipset": ["Snapdragon 8 Gen 3", "Snapdragon 7 Gen 3", "Dimensity 7200", "Dimensity 9300", "Helio G99", "Exynos 2400", "Apple A17 Pro", "Apple A18", "Tensor G4", "RTX 4060 Ti", "RTX 4070 Super", "RX 7800 XT"],
  "Battery": ["3000mAh", "4500mAh", "5000mAh", "6000mAh", "10000mAh", "20000mAh", "30 Hours", "50 Hours"],
  "Network": ["4G", "5G"],
  "Connectivity": ["Wired", "Bluetooth 5.3", "Bluetooth 5.4", "2.4GHz Wireless", "Tri-mode", "Wi-Fi", "Wi-Fi + Bluetooth"],
  "Driver Size": ["10mm", "12mm", "40mm", "50mm"],
  "Layout": ["Full size", "TKL", "75%", "65%", "60%"],
  "DPI": ["1600", "3200", "8000", "16000", "26000", "30000"],
  "Wi-Fi Standard": ["Wi-Fi 5", "Wi-Fi 6", "Wi-Fi 6E", "Wi-Fi 7"],
  "Ports": ["2 Ports", "3 Ports", "4 Ports", "5 Ports", "8 Ports"],
  "Interface": ["SATA III", "NVMe PCIe 3.0", "NVMe PCIe 4.0", "NVMe PCIe 5.0", "USB 3.2"],
  "Read Speed": ["550MB/s", "2100MB/s", "3500MB/s", "5000MB/s", "7000MB/s", "12000MB/s"],
  "RPM": ["5400 RPM", "7200 RPM"],
  "Memory Type": ["DDR4", "DDR5", "GDDR6", "GDDR6X"],
  "Bus Speed": ["3200MHz", "3600MHz", "4800MHz", "5600MHz", "6000MHz", "6400MHz"],
  "Socket": ["LGA1700", "LGA1851", "AM4", "AM5"],
  "Sensor": ["APS-C", "Full Frame", "Micro Four Thirds"],
  "Print Type": ["Inkjet", "Laser", "Ink Tank", "Dot Matrix"],
  "Energy Rating": ["3 Star", "4 Star", "5 Star", "Inverter"],
  "Capacity Litres": ["180L", "250L", "320L", "410L", "550L"],
  "Material": ["Silicone", "TPU", "Leather", "Polycarbonate", "Aramid Fibre"],
};
const BANGLA_WORDS = ["মোবাইল", "ল্যাপটপ", "হেডফোন", "স্মার্ট ঘড়ি", "চার্জার", "পাওয়ার ব্যাংক", "কম্পিউটার", "মনিটর", "টেলিভিশন", "ফ্রিজ", "এসি", "ক্যামেরা"];
const FIRST = ["Rahim", "Karim", "Nusrat", "Farhana", "Tanvir", "Sabbir", "Mehedi", "Sadia", "Arif", "Jannat", "Rakib", "Mim", "Shakil", "Sumaiya", "Imran", "Tasnim", "Fahim", "Riya", "Hasan", "Nadia"];
const LAST = ["Hossain", "Rahman", "Islam", "Ahmed", "Akter", "Khan", "Chowdhury", "Uddin", "Sarkar", "Miah", "Begum", "Talukder"];
const CITIES = ["Dhaka", "Chattogram", "Sylhet", "Rajshahi", "Khulna", "Barishal", "Rangpur", "Mymensingh", "Cumilla", "Gazipur"];

// ---------------------------------------------------------------- statements
const insert = (sql) => db.prepare(sql);
const insCategory = insert(`INSERT INTO categories (id, name, slug, description, meta_title, meta_description, status, revision, no_index, exclude_from_sitemap, created_at, updated_at, deleted_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`);
const insAttribute = insert(`INSERT INTO product_attributes (id, name, slug, filterable, options, created_at, updated_at, key_spec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insBrand = insert(`INSERT INTO brands (id, name, slug, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'published', ?, ?, ?)`);
const insMedia = insert(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, width, height, variant_width, status, created_at, updated_at) VALUES (?, ?, 'image', ?, ?, 'image/webp', ?, 1600, 1600, 1600, 'ready', ?, ?)`);
const insProduct = insert(`INSERT INTO products (id, name, description, price_minor, category_id, slug, meta_title, meta_description, no_index, exclude_from_sitemap, exclude_from_product_feed, product_condition, is_active, discount_bps, discount_type, discount_amount_minor, free_delivery, created_at, updated_at, deleted_at, brand_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'percentage', 0, ?, ?, ?, ?, ?)`);
const insProductMedia = insert(`INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insOptionDef = insert(`INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insOptionValue = insert(`INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const insVariant = insert(`INSERT INTO product_variants (id, product_id, option_combination_key, image_id, weight, sku, price_minor, stock, reserved_stock, preorder_stock, is_default, track_inventory, version, stock_version, low_stock_threshold, discount_bps, discount_type, discount_amount_minor, barcode, barcode_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, ?, ?, 'percentage', 0, ?, ?, ?, ?)`);
const insVariantOption = insert(`INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES (?, ?, ?)`);
const insMovement = insert(`INSERT INTO inventory_movements (id, variant_id, order_id, type, quantity, previous_stock, new_stock, notes, created_by, ledger_version, pool, reservation_generation, stock_version_before, stock_version_after, stock_delta, previous_reserved_stock, new_reserved_stock, reserved_stock_delta, previous_preorder_stock, new_preorder_stock, preorder_stock_delta, created_at) VALUES (?, ?, NULL, 'adjusted', ?, 0, ?, 'Stocktake: catalog-scale seed', NULL, 2, 'regular', NULL, 1, 2, ?, 0, 0, 0, 0, 0, 0, ?)`);
const insAttrValue = insert(`INSERT INTO product_attribute_values (id, product_id, attribute_id, value, created_at) VALUES (?, ?, ?, ?, ?)`);
const insCollection = insert(`INSERT INTO collections (id, name, description, presentation, config, sort_order, is_active, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`);
const insCustomer = insert(`INSERT INTO customers (id, name, email, phone, address, city, city_name, total_orders, last_order_at, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'order', ?, ?)`);
const insOrder = insert(`INSERT INTO orders (id, order_number, customer_name, customer_phone, customer_email, shipping_address, city, zone, city_name, zone_name, status, payment_method, payment_status, fulfillment_status, customer_id, currency_code, currency_decimal_places, subtotal_amount_minor, shipping_amount_minor, total_amount_minor, paid_amount_minor, balance_due_minor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BDT', 2, ?, ?, ?, ?, ?, ?, ?)`);
const insOrderItem = insert(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, variant_label, inventory_tracked, unit_price_minor, line_subtotal_minor, taxable_amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);

// ---------------------------------------------------------------- categories
const categories = [];
tx(() => {
  // A Startech-style tree through `parent_id` (triggers keep depth, path and
  // category_closure): family > qualifier > brand > brand, four levels.
  let index = 0;
  for (const family of FAMILIES) {
    const push = (name, depth, parentId = null) => {
      if (categories.length >= CATEGORIES) return null;
      const id = `cat_scale_${pad(index, 4)}`;
      const status = index % 40 === 7 ? "draft" : index % 40 === 19 ? "internal" : "published";
      const createdAt = NOW - (800 - index) * DAY;
      insCategory.run(id, name, `${slugify(name)}-${index}`, `<p>Shop ${name} at the best price in Bangladesh. Genuine products with official warranty.</p>`,
        `${name} Price in Bangladesh`, `Buy ${name} online in Bangladesh.`, status, index % 97 === 3 ? 1 : 0, index % 89 === 5 ? 1 : 0, createdAt, createdAt, null, parentId);
      categories.push({ id, name, family, depth, status });
      index += 1;
      return id;
    };
    const root = push(family.name, 1);
    for (const qualifier of sample(QUALIFIERS, 5)) {
      let parent = push(`${qualifier} ${family.name}`, 2, root);
      sample(BRAND_ROOTS, 2).forEach((brand, level) => {
        parent = push(`${brand} ${qualifier} ${family.name}`, 3 + level, parent);
      });
    }
  }
  while (categories.length < CATEGORIES) {
    const family = pick(FAMILIES);
    const id = `cat_scale_${pad(categories.length, 4)}`;
    const name = `${pick(BRAND_ROOTS)} ${pick(QUALIFIERS)} ${family.name} ${categories.length}`;
    const createdAt = NOW - (800 - categories.length) * DAY;
    insCategory.run(id, name, `${slugify(name)}-${categories.length}`, null, null, null, "published", 0, 0, createdAt, createdAt, null, null);
    categories.push({ id, name, family, depth: 4, status: "published" });
  }
});
log(`categories: ${categories.length}`);

// ---------------------------------------------------------------- attributes
const brands = [];
for (let i = 0; brands.length < BRANDS; i += 1) {
  const rootName = BRAND_ROOTS[i % BRAND_ROOTS.length];
  brands.push(i < BRAND_ROOTS.length ? rootName : `${rootName} ${["Pro", "Plus", "Max", "Lite", "Neo"][Math.floor(i / BRAND_ROOTS.length) - 1]}`);
}
// Headline specs shown on spec cards and in the buy box (Star Tech's card bullets).
const KEY_SPECS = new Set(["Processor", "RAM", "Storage", "Display Size", "Graphics", "Chipset", "Battery", "Capacity Litres"]);
const attributes = new Map();
const brandIds = new Map();
tx(() => {
  const slugs = new Set();
  brands.forEach((name, position) => {
    const id = `brd_scale_${pad(position, 4)}`;
    let slug = slugify(name);
    if (slugs.has(slug)) slug = `${slug}-${position}`;
    slugs.add(slug);
    insBrand.run(id, name, slug, position, NOW - 900 * DAY, NOW - 900 * DAY);
    brandIds.set(name, id);
  });
  attributes.set("Brand", { id: "attr_scale_brand", values: brands });
  insAttribute.run("attr_scale_brand", "Brand", "brand", 1, JSON.stringify(brands), NOW - 900 * DAY, NOW - 900 * DAY, 0);
  let index = 0;
  for (const [name, values] of Object.entries(SPEC_VALUES)) {
    const id = `attr_scale_${pad(index, 3)}`;
    attributes.set(name, { id, values });
    insAttribute.run(id, name, slugify(name), index % 6 === 5 ? 0 : 1, JSON.stringify(values), NOW - 900 * DAY, NOW - 900 * DAY, KEY_SPECS.has(name) ? 1 : 0);
    index += 1;
  }
});
log(`brands: ${brandIds.size}; attributes: ${attributes.size} (Brand has ${brands.length} values, ${KEY_SPECS.size} key specs)`);

// ---------------------------------------------------------------- products
const publishedCategories = categories.filter((category) => category.status === "published");
const stats = { products: 0, simple: 0, optioned: 0, variants: 0, media: 0, movements: 0, attributeValues: 0 };
const productRows = [];
let barcodeSerial = 1;
const BATCH = 1000;

function productName(family, brand, index, bangla) {
  const series = pick(SERIES);
  const model = `${String.fromCharCode(65 + int(0, 25))}${int(10, 999)}${pick(["", "X", "S", "Z", "HX", "U"])}`;
  const spec = family.specs.length && chance(0.7)
    ? ` ${pick(SPEC_VALUES[family.specs[0]] ?? [""])}`
    : "";
  const base = `${brand} ${series} ${model}${spec} ${family.name}`;
  return bangla ? `${base} ${pick(BANGLA_WORDS)}` : base;
}

function seedProduct(index) {
  // Real stores are lopsided: one family root holds thousands of products
  // (Startech "Laptop"), the other family roots hundreds, the leaves dozens.
  const roll = rand();
  const leaf = chance(0.97) ? pick(publishedCategories) : pick(categories);
  const category = roll < 0.1
    ? categories[0]
    : roll < 0.35 ? categories.find((candidate) => candidate.family === leaf.family && candidate.depth === 1) ?? leaf : leaf;
  const family = category.family;
  const brand = pick(brands);
  const bangla = chance(0.08);
  const name = productName(family, brand, index, bangla);
  const id = `prod_scale_${pad(index, 6)}`;
  const createdAt = NOW - int(0, 720) * DAY - int(0, DAY);
  const updatedAt = createdAt + int(0, 30) * DAY;
  const deletedAt = chance(0.01) ? updatedAt + DAY : null;
  const isActive = chance(0.95) ? 1 : 0;
  const basePrice = Math.round(int(family.price[0], family.price[1]) / 10) * 10;
  const discountBps = chance(0.25) ? pick([500, 1000, 1500, 2000]) : 0;
  const paragraphs = int(2, 6);
  const description = Array.from({ length: paragraphs }, (_, p) =>
    `<p>${name} ${p === 0 ? "comes with" : "also offers"} ${pick(QUALIFIERS).toLowerCase()} performance, ${pick(SPEC_VALUES.Warranty)} warranty and fast delivery across Bangladesh. ${bangla ? "সারা বাংলাদেশে হোম ডেলিভারি। " : ""}Model ${index} is available in official and unofficial variants.</p>`).join("");

  // Option shape: one family-defined shape per product; ~2% are large sets.
  const large = family.axes.length === 2 && chance(0.05);
  const optioned = family.axes.length > 0 && (large || chance(0.7));
  let axes = [];
  if (optioned) {
    const axisCount = family.axes.length === 2 && (large || chance(0.5)) ? 2 : 1;
    axes = family.axes.slice(0, axisCount).map(([axisName, values]) => [
      axisName,
      large ? values : sample(values, Math.min(values.length, int(axisCount === 2 ? 2 : 3, axisCount === 2 ? 3 : 5))),
    ]);
  }
  const combos = axes.length === 0
    ? []
    : axes.length === 1
      ? axes[0][1].map((value) => [value])
      : axes[0][1].flatMap((first) => axes[1][1].map((second) => [first, second]));

  const variantPrices = combos.map((_, comboIndex) => basePrice + comboIndex * Math.round(basePrice * 0.05 / 100) * 100);
  const priceMinor = (optioned ? Math.min(...variantPrices) : basePrice) * 100;
  insProduct.run(id, name, description, priceMinor, category.id, `${slugify(name).slice(0, 80)}-${index}`,
    chance(0.3) ? `${name} Price in BD` : null, `Buy ${name} at the best price in Bangladesh.`,
    chance(0.01) ? 1 : 0, chance(0.01) ? 1 : 0, chance(0.02) ? 1 : 0, chance(0.9) ? "new" : chance(0.5) ? "refurbished" : null,
    isActive, optioned ? 0 : discountBps, chance(0.05) ? 1 : 0, createdAt, updatedAt, deletedAt, brandIds.get(brand));
  productRows.push({ id, name, optioned, deletedAt, isActive });

  // Media: 1-4 ready images, first is primary.
  const imageCount = int(1, 4);
  const productMediaIds = [];
  for (let m = 0; m < imageCount; m += 1) {
    const mediaId = `med_scale_${pad(index, 6)}_${m}`;
    insMedia.run(mediaId, `${slugify(name).slice(0, 60)}-${m}.webp`, `media/${mediaId}.webp`, int(20000, 400000), `${name} image ${m + 1}`, createdAt, createdAt);
    const pmedId = `pmed_scale_${pad(index, 6)}_${m}`;
    insProductMedia.run(pmedId, id, mediaId, m === 0 ? name.slice(0, 500) : null, m === 0 ? 1 : 0, m, createdAt, createdAt);
    productMediaIds.push(pmedId);
    stats.media += 1;
  }

  // Specs: Brand + 3-7 family specs.
  const attributeNames = ["Brand", ...sample(family.specs, int(Math.min(3, family.specs.length), family.specs.length))];
  for (const attributeName of attributeNames) {
    const attribute = attributes.get(attributeName);
    if (!attribute) continue;
    const value = attributeName === "Brand" ? brand : pick(attribute.values);
    insAttrValue.run(`val_scale_${pad(index, 6)}_${attribute.id.slice(-3)}`, id, attribute.id, value, createdAt);
    stats.attributeValues += 1;
  }

  const stockFor = (variantId, trackInventory, stock) => {
    if (!trackInventory || stock <= 0) return;
    insMovement.run(`mov_scale_${variantId.slice(4)}`, variantId, stock, stock, stock, createdAt);
    stats.movements += 1;
  };

  if (!optioned) {
    const variantId = `var_scale_${pad(index, 6)}_d`;
    const trackInventory = chance(0.85) ? 1 : 0;
    const stock = trackInventory ? (chance(0.12) ? 0 : int(1, 250)) : 0;
    const barcode = chance(0.5) ? ean13(barcodeSerial++) : null;
    insVariant.run(variantId, id, null, null, chance(0.6) ? Number((rand() * 5).toFixed(2)) : null,
      `SC-${pad(index, 6)}`, priceMinor, stock, 1, trackInventory, stock > 0 ? 2 : 1, chance(0.3) ? 5 : null,
      0, barcode, barcode ? "ean13" : null, createdAt, updatedAt);
    stockFor(variantId, trackInventory, stock);
    stats.simple += 1;
    stats.variants += 1;
    return;
  }

  const definitionIds = [];
  const valueIds = [];
  axes.forEach(([axisName, values], position) => {
    const definitionId = `popt_scale_${pad(index, 6)}_${position}`;
    const mapping = axisName === "Color" ? "color" : axisName === "Size" ? "size" : axisName === "Material" ? "material" : "none";
    insOptionDef.run(definitionId, id, axisName, axisName.toLowerCase(), position, mapping, createdAt, createdAt);
    definitionIds.push(definitionId);
    valueIds.push(values.map((value, valuePosition) => {
      const valueId = `pval_scale_${pad(index, 6)}_${position}_${valuePosition}`;
      insOptionValue.run(valueId, definitionId, value, value.toLowerCase(), valuePosition, createdAt, createdAt);
      return valueId;
    }));
  });
  combos.forEach((combo, comboIndex) => {
    const variantId = `var_scale_${pad(index, 6)}_${comboIndex}`;
    const selected = combo.map((value, axisIndex) => valueIds[axisIndex][axes[axisIndex][1].indexOf(value)]);
    const trackInventory = chance(0.9) ? 1 : 0;
    const stock = trackInventory ? (chance(0.18) ? 0 : int(1, 80)) : 0;
    const barcode = chance(0.5) ? ean13(barcodeSerial++) : null;
    const imageId = productMediaIds.length > 1 && chance(0.4) ? productMediaIds[comboIndex % productMediaIds.length] : null;
    insVariant.run(variantId, id, selected.join("|"), imageId, null,
      `SC-${pad(index, 6)}-${combo.map((value) => slugify(value).toUpperCase()).join("-")}`,
      variantPrices[comboIndex] * 100, stock, 0, trackInventory, stock > 0 ? 2 : 1, null,
      chance(0.2) ? pick([500, 1000]) : 0, barcode, barcode ? "ean13" : null, createdAt, updatedAt);
    selected.forEach((valueId, axisIndex) => insVariantOption.run(variantId, definitionIds[axisIndex], valueId));
    stockFor(variantId, trackInventory, stock);
    stats.variants += 1;
  });
  stats.optioned += 1;
}

for (let start = 0; start < PRODUCTS; start += BATCH) {
  tx(() => {
    for (let index = start; index < Math.min(PRODUCTS, start + BATCH); index += 1) {
      seedProduct(index);
      stats.products += 1;
    }
  });
  if ((start / BATCH) % 5 === 4) log(`products: ${stats.products} (variants ${stats.variants})`);
}
log(`products: ${JSON.stringify(stats)}`);

// ---------------------------------------------------------------- collections
const liveProducts = productRows.filter((row) => row.isActive && !row.deletedAt);
tx(() => {
  for (let index = 0; index < COLLECTIONS; index += 1) {
    const dynamic = index % 2 === 1;
    const config = dynamic
      ? { source: "dynamic", categoryIds: sample(publishedCategories, int(1, 12)).map((category) => category.id), productIds: [], showOnHomepage: index < 10, maxProducts: int(8, 24), title: `Top picks ${index}`, subtitle: "" }
      : { source: "manual", categoryIds: [], productIds: sample(liveProducts, int(8, 90)).map((row) => row.id), showOnHomepage: index < 10, maxProducts: int(8, 24), title: `Featured ${index}`, subtitle: "" };
    const createdAt = NOW - (400 - index) * DAY;
    insCollection.run(`col_scale_${pad(index, 3)}`, `${dynamic ? "Best of" : "Featured"} ${pick(FAMILIES).name} ${index}`, null,
      index % 3 === 0 ? "carousel" : "grid", JSON.stringify(config), index, createdAt, createdAt);
  }
});
log(`collections: ${COLLECTIONS}`);

// ---------------------------------------------------------------- customers + orders
const variantsByProduct = db.prepare(`SELECT id, product_id, sku, price_minor FROM product_variants WHERE deleted_at IS NULL`).all();
const customerIds = [];
tx(() => {
  for (let index = 0; index < CUSTOMERS; index += 1) {
    const id = `cus_scale_${pad(index, 6)}`;
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const city = pick(CITIES);
    const createdAt = NOW - int(0, 700) * DAY;
    insCustomer.run(id, name, chance(0.5) ? `customer${index}@example.test` : null, `017${pad(index, 8)}`,
      `House ${int(1, 200)}, Road ${int(1, 30)}, ${city}`, city, city, 0, null, createdAt, createdAt);
    customerIds.push({ id, name, city, phone: `017${pad(index, 8)}` });
  }
});
log(`customers: ${CUSTOMERS}`);

const STATUSES = ["pending", "processing", "confirmed", "shipped", "delivered", "completed", "completed", "completed", "cancelled", "returned"];
let orderItems = 0;
for (let start = 0; start < ORDERS; start += 5000) {
  tx(() => {
    for (let index = start; index < Math.min(ORDERS, start + 5000); index += 1) {
      const customer = pick(customerIds);
      const status = pick(STATUSES);
      const createdAt = NOW - int(0, 700) * DAY - int(0, DAY);
      const lines = Array.from({ length: int(1, 4) }, () => pick(variantsByProduct));
      const quantities = lines.map(() => int(1, 3));
      const subtotal = lines.reduce((sum, line, lineIndex) => sum + line.price_minor * quantities[lineIndex], 0);
      const shipping = pick([6000, 12000, 0]);
      const total = subtotal + shipping;
      const paid = status === "completed" || status === "delivered" ? total : 0;
      const id = `ord_scale_${pad(index, 6)}`;
      insOrder.run(id, 100000 + index, customer.name, customer.phone, null, `House ${int(1, 200)}, ${customer.city}`,
        customer.city, "zone", customer.city, "Zone", status, chance(0.8) ? "cod" : "sslcommerz",
        paid ? "paid" : "unpaid", status === "completed" || status === "delivered" ? "complete" : "pending", customer.id,
        subtotal, shipping, total, paid, total - paid, createdAt, createdAt + int(0, 10) * DAY);
      lines.forEach((line, lineIndex) => {
        insOrderItem.run(`oi_scale_${pad(index, 6)}_${lineIndex}`, id, line.product_id, line.id, quantities[lineIndex],
          line.sku, null, line.price_minor, line.price_minor * quantities[lineIndex], line.price_minor * quantities[lineIndex], createdAt);
        orderItems += 1;
      });
    }
  });
}
db.exec(`UPDATE customers SET total_orders = (SELECT count(*) FROM orders WHERE orders.customer_id = customers.id), last_order_at = (SELECT max(created_at) FROM orders WHERE orders.customer_id = customers.id)`);
log(`orders: ${ORDERS} (items ${orderItems})`);

// ---------------------------------------------------------------- projections
// The buyer state and facet projections every write keeps in its batch,
// filled for the whole seed by migration 0091's idempotent statements.
const fill = readFileSync(join(root, "packages/database/migrations/0091_catalogue_projection_fill.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement && !/^INSERT\s+INTO\s+[`"]?scalius_schema_migrations/i.test(statement));
tx(() => {
  for (const statement of fill) db.exec(statement);
});
log(`projections: ${db.prepare("SELECT count(*) AS n FROM product_buyer_state WHERE is_public = 1").get().n} public products`);

// No ANALYZE: a migrated D1 has no sqlite_stat1, so plans here match production.
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
const counts = Object.fromEntries(["products", "product_variants", "product_media", "media", "product_option_definitions", "product_option_values", "product_variant_option_values", "product_attribute_values", "inventory_movements", "categories", "category_closure", "brands", "product_buyer_state", "product_facet_values", "collections", "customers", "orders", "order_items"].map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
console.log(JSON.stringify(counts, null, 2));
db.close();
log("done");
