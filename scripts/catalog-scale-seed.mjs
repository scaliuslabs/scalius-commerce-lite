#!/usr/bin/env node
/**
 * catalog-scale-seed.mjs — deterministic large-catalogue seed for LOCAL load
 * and capacity tests (Startech/Applegadgets scale, and a "huge" profile).
 *
 *   node scripts/catalog-scale-seed.mjs --state /tmp/catalog-scale/state
 *   node scripts/catalog-scale-seed.mjs --state <ABSOLUTE dir> --profile huge
 *
 * Writes straight into the SQLite file of a local Miniflare D1 state
 * directory you own (apply migrations to it first with
 * `SCALIUS_WRANGLER_STATE=<dir> node scripts/deploy.mjs --migrate-only --local`),
 * with no Worker running against it. It never touches remote D1 and refuses the
 * shared repo `.wrangler/state`.
 *
 * Default profile (override with --products, --customers, --orders, --seed):
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
 *
 * Huge profile (--profile huge): ~50k products, ~140k SKUs, 800 categories,
 * 500 brands, 200k customers and 1,000,000 orders over three years with
 * seasonality (1-5 lines, statuses, payment states, fulfilments, returns,
 * refunds, discounts, tax, two foreign-currency markets), ~100k reviews,
 * ~2k promotions, gift cards, ~20k inbox conversations with ~150k messages,
 * 15 staff users, notification history and audit events, plus the edge data a
 * real store grows: 120+ character names, ~20% Bangla names, products with 0
 * and 20 images, a 100-SKU product on five option axes, a customer with 500
 * orders, a 99-line order, zero-stock and backorder SKUs, draft, archived and
 * trashed records, and empty optional fields. It aims at under 30 minutes and
 * a few GB, aborts below 6 GB of free disk, and prints progress and the final
 * size.
 *
 * Exact commands (this script never runs `pnpm dev`; you start the stack):
 *
 *   STATE=/ABSOLUTE/path/outside/the/repo/huge-state
 *   mkdir -p "$STATE"
 *   SCALIUS_WRANGLER_STATE="$STATE" node scripts/deploy.mjs --migrate-only --local
 *   node scripts/catalog-scale-seed.mjs --state "$STATE" --profile huge
 *   pnpm dev --state "$STATE"            # in a second terminal
 *   pnpm dev:admin:create --state "$STATE" --no-start --skip-migrations   # once the stack is up
 *   node scripts/catalog-scale-seed.mjs --state "$STATE" --staff-roles
 *
 * Staff users are written without role assignments, because the one-shot
 * `/api/v1/setup` (what `scripts/dev-admin.mjs` calls) refuses once any user
 * holds permissions. After the local admin exists, `--staff-roles` assigns the
 * seeded staff their system roles (it adds the system role rows by name; the
 * API's RBAC reconciliation fills their permissions on the next request).
 *
 * Seed-time domain events: the `evt_*` triggers of
 * `packages/database/scripts/event-outbox-triggers.ts` are dropped for the huge
 * run and recreated at the end (their SQL is saved beside the database first,
 * and `--restore-triggers` recreates them after a crash), then `event_outbox`
 * is emptied. That is safe for a local seed: the outbox is a replay queue for
 * webhooks and apps, and history that exists at seed time was never
 * "published", so replaying millions of order.created events would only flood
 * the queue. Every other trigger (FTS, cache dependencies, customer stats,
 * fulfilment, ledger and money guards) stays on, so derived state is the real
 * trigger-maintained state.
 */

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verify } from "./catalog-scale-verify.mjs";
import { DAY, buildClock, convertMinor, createCustomerPicker, createRng, invertRate, padName, pad, paymentLedgerState, pickLifecycle, popularIndex, priceOrder, resolveProfile, sampleTime } from "./catalog-scale-shapes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}
const flag = (name) => process.argv.includes(name);
const numberArg = (name) => (arg(name, undefined) === undefined ? undefined : Number(arg(name)));

const statePath = arg("--state", null);
if (!statePath) {
  console.error("Usage: node scripts/catalog-scale-seed.mjs --state <local wrangler state dir> [--profile default|huge] [--products 30000] [--customers 20000] [--orders 50000] [--seed 20260925] | --staff-roles | --restore-triggers");
  process.exit(1);
}
const PROFILE = resolveProfile(arg("--profile", "default"), {
  products: numberArg("--products"),
  customers: numberArg("--customers"),
  orders: numberArg("--orders"),
  reviews: numberArg("--reviews"),
  conversations: numberArg("--conversations"),
  messages: numberArg("--messages"),
  promotions: numberArg("--promotions"),
});
const PRODUCTS = PROFILE.products;
const CUSTOMERS = PROFILE.customers;
const ORDERS = PROFILE.orders;
const SEED = Number(arg("--seed", "20260925"));
const CATEGORIES = PROFILE.categories;
const BRANDS = PROFILE.brands;
const COLLECTIONS = 50;
const HUGE = PROFILE.huge;

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
const dbPath = join(d1Dir, dbFiles[0]);

// Free disk: the huge profile needs room for the database, its WAL and the
// final checkpoint, so it stops cleanly below 6 GB free.
function freeGigabytes(path) {
  const lines = execFileSync("df", ["-k", path], { encoding: "utf8" }).trim().split("\n");
  return Number(lines[lines.length - 1].trim().split(/\s+/)[3]) / (1024 * 1024);
}
const free = freeGigabytes(resolvedState);
console.log(`profile ${PROFILE.name}; free disk ${free.toFixed(1)} GB`);
if (HUGE && free < 6) {
  console.error(`Only ${free.toFixed(1)} GB free; the huge profile needs at least 6 GB. Nothing was written.`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -800000;");

// ------------------------------------------------------- dropped-trigger guard
const droppedFile = join(resolvedState, "seed-dropped-triggers.sql");
const TRIGGER_SEPARATOR = "\n-- next --\n";
function restoreTriggers() {
  if (!existsSync(droppedFile)) return 0;
  const statements = readFileSync(droppedFile, "utf8").split(TRIGGER_SEPARATOR).filter((statement) => statement.trim());
  for (const statement of statements) db.exec(statement);
  unlinkSync(droppedFile);
  return statements.length;
}
if (flag("--restore-triggers")) {
  console.log(`restored ${restoreTriggers()} triggers`);
  db.close();
  process.exit(0);
}
if (existsSync(droppedFile)) {
  console.error(`${droppedFile} exists: a previous huge seed stopped before restoring the event triggers. Run with --restore-triggers, or recreate the state.`);
  process.exit(1);
}

// ------------------------------------------------------------- staff-roles step
const SYSTEM_ROLES = [
  ["super_admin", "Super Admin", "Full access to all features and settings."],
  ["manager", "Manager", "Full access except sensitive settings and role management."],
  ["sales_rep", "Sales Representative", "Access to orders, customers, and product viewing."],
  ["content_editor", "Content Editor", "Access to pages, media, and content settings."],
  ["product_specialist", "Product Specialist", "Full access to products, categories, collections, and attributes."],
];
const STAFF_ROLE_MIX = ["manager", "manager", "sales_rep", "sales_rep", "sales_rep", "sales_rep", "sales_rep", "content_editor", "content_editor", "product_specialist", "product_specialist", "product_specialist", "sales_rep", "manager", "sales_rep"];
if (flag("--staff-roles")) {
  const admin = db.prepare("SELECT id FROM user WHERE is_super_admin = 1 LIMIT 1").get();
  if (!admin) {
    console.error("No super admin exists yet. Create the local admin first (pnpm dev:admin:create), then rerun with --staff-roles.");
    process.exit(1);
  }
  const staff = db.prepare("SELECT id, email FROM user WHERE email LIKE 'staff%@example.test' ORDER BY email").all();
  const roleIds = new Map();
  for (const [name, displayName, description] of SYSTEM_ROLES) {
    const row = db.prepare("SELECT id FROM roles WHERE name = ?").get(name);
    if (row) roleIds.set(name, row.id);
    else {
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO roles (id, name, display_name, description, is_system) VALUES (?, ?, ?, ?, 1)").run(id, name, displayName, description);
      roleIds.set(name, id);
    }
  }
  let assigned = 0;
  staff.forEach((member, index) => {
    if (db.prepare("SELECT 1 FROM user_roles WHERE user_id = ?").get(member.id)) return;
    db.prepare("INSERT INTO user_roles (id, user_id, role_id, assigned_by) VALUES (?, ?, ?, ?)").run(`ur_staff_${pad(index, 2)}`, member.id, roleIds.get(STAFF_ROLE_MIX[index % STAFF_ROLE_MIX.length]), admin.id);
    assigned += 1;
  });
  console.log(`assigned roles to ${assigned} of ${staff.length} staff users`);
  db.close();
  process.exit(0);
}

if (flag("--verify")) {
  const failed = verify(db, { deep: flag("--deep") });
  db.close();
  process.exit(failed === 0 ? 0 : 1);
}

const existing = db.prepare("SELECT count(*) AS n FROM products").get().n;
if (existing > 0) {
  console.error(`products already has ${existing} rows; seed an empty migrated state.`);
  process.exit(1);
}

// ---------------------------------------------------------------- determinism
const rng = createRng(SEED);
const { rand, int, pick, chance } = rng;
function sample(list, count) {
  const copy = [...list];
  const out = [];
  while (out.length < count && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
// A second stream for the huge-only phases keeps the default stream untouched.
const hrng = createRng((SEED ^ 0x5bd1e995) >>> 0);
const slugify = (value) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function ean13(n) {
  const body = `20${pad(n, 10)}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(body[i]) * (i % 2 ? 3 : 1);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

const NOW = 1790000000; // fixed epoch so the seed is byte-for-byte repeatable
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
const checkpoint = () => db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

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
// Huge-profile vocabulary: Bangla names and addresses (about 20% of the store),
// merchant filler that pushes names past 120 characters, and inbox copy.
const BANGLA_FIRST = ["রহিম", "করিম", "নুসরাত", "ফারহানা", "তানভীর", "সাব্বির", "মেহেদী", "সাদিয়া", "আরিফ", "জান্নাত", "রাকিব", "মিম", "শাকিল", "সুমাইয়া", "ইমরান", "তাসনিম", "ফাহিম", "রিয়া", "হাসান", "নাদিয়া"];
const BANGLA_LAST = ["হোসেন", "রহমান", "ইসলাম", "আহমেদ", "আক্তার", "খান", "চৌধুরী", "উদ্দিন", "সরকার", "মিয়া", "বেগম", "তালুকদার"];
const BANGLA_AREAS = ["গুলশান", "ধানমন্ডি", "মিরপুর", "উত্তরা", "বনানী", "মতিঝিল", "মোহাম্মদপুর", "বসুন্ধরা", "যাত্রাবাড়ী", "আগ্রাবাদ"];
const BANGLA_PRODUCT_NAMES = ["অ্যাসুস ভিভোবুক ১৫ ল্যাপটপ", "স্যামসাং গ্যালাক্সি এস২৪ স্মার্টফোন", "শাওমি রেডমি নোট ১৩ মোবাইল", "ওয়ালটন ফ্রিজ ২৫০ লিটার", "সনি ব্রাভিয়া ৫৫ ইঞ্চি টেলিভিশন", "এইচপি লেজারজেট প্রিন্টার", "লজিটেক ওয়্যারলেস মাউস", "আনকার ২০০০০ এমএএইচ পাওয়ার ব্যাংক"];
const AREAS = ["Gulshan", "Dhanmondi", "Mirpur", "Uttara", "Banani", "Motijheel", "Mohammadpur", "Bashundhara", "Jatrabari", "Agrabad"];
const NAME_FILLER = ["with official warranty and genuine box", "limited edition bundle including original charger, protective case and carry pouch", "imported from the authorised distributor with a seven day replacement guarantee", "complete accessories pack for home, office and travel use", "cash on delivery available across Bangladesh"];
const REVIEW_TITLES = ["Great value", "Works as described", "Fast delivery", "Not what I expected", "Perfect for daily use", "Solid build quality", "Good but pricey", "Highly recommended", "Average", "Excellent!"];
const REVIEW_BODIES = ["Arrived on time and well packed. Does exactly what the listing says.", "Using it for two weeks now and no complaints so far.", "The finish is better than I expected for this price.", "Battery life could be better but everything else is great.", "Customer support helped me pick the right model.", "Genuine product with warranty card, happy with the purchase.", "Delivery took a day longer than promised but the item is fine.", "Compared three shops and this one had the best price."];
const BANGLA_REVIEW_BODIES = ["পণ্যটি খুব ভালো, সময়মতো হাতে পেয়েছি।", "দামের তুলনায় মান অসাধারণ।", "প্যাকেজিং ভালো ছিল, আসল পণ্য।", "ডেলিভারি একটু দেরি হয়েছে কিন্তু পণ্য ঠিক আছে।", "দুই সপ্তাহ ব্যবহার করছি, কোনো সমস্যা নেই।"];
const MESSAGE_CUSTOMER = ["Hi, where is my order? It has been a few days.", "Can I change the delivery address for this order?", "The product arrived with a scratch on the side.", "Do you provide a warranty card with this item?", "I would like to return this, it does not fit my needs.", "Is this model available in another colour?", "I was charged but the order still shows unpaid.", "Thank you, received it today."];
const MESSAGE_STAFF = ["Thanks for reaching out. Let me check with our courier right now.", "Sure, I have updated the address on your order.", "Sorry about that. We will send a replacement, please share a photo.", "Yes, every item ships with an official warranty card.", "We have opened a return request for you. The courier will collect the parcel.", "This model comes in black and silver; I can switch your order if you like.", "I can see the payment on our side now, the order is confirmed.", "Happy to help. Closing this conversation, message us any time."];
const MESSAGE_BANGLA = ["আমার অর্ডারটি কবে পাব?", "ধন্যবাদ, পণ্য পেয়েছি।", "ঠিকানা পরিবর্তন করা যাবে কি?", "পণ্যটির ওয়ারেন্টি আছে কি?"];
const RETURN_REASONS = ["Item arrived damaged", "Wrong item received", "Changed my mind", "Does not match the description", "Defective on arrival"];

// ---------------------------------------------------------------- statements
const insert = (sql) => db.prepare(sql);
/** A 96x96 neutral WebP (86 bytes): the body of every seeded media object. */
const PLACEHOLDER_IMAGE = Buffer.from("UklGRk4AAABXRUJQVlA4IEIAAACwBACdASpgAGAAPu12uFYppyUjoOgBMB2JaQAAB3erzmXuNPrnZPPBKt5ZQKNAAP7viMrxw3vH8wBUzS14oAAAAAA=", "base64");
const insCategory = insert(`INSERT INTO categories (id, name, slug, description, meta_title, meta_description, status, revision, no_index, exclude_from_sitemap, created_at, updated_at, deleted_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`);
const insAttribute = insert(`INSERT INTO product_attributes (id, name, slug, filterable, options, created_at, updated_at, key_spec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insBrand = insert(`INSERT INTO brands (id, name, slug, status, sort_order, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
// The seeded media rows point at real (placeholder) objects in the local R2 state, so every image
// answers 200: the original only (`variant_width` NULL means no pre-generated renditions).
const insMedia = insert(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, width, height, variant_width, status, created_at, updated_at) VALUES (?, ?, 'image', ?, ?, 'image/webp', ?, 96, 96, NULL, 'ready', ?, ?)`);
const insProduct = insert(`INSERT INTO products (id, name, description, price_minor, category_id, slug, meta_title, meta_description, no_index, exclude_from_sitemap, product_condition, is_active, discount_bps, discount_type, discount_amount_minor, free_delivery, created_at, updated_at, deleted_at, brand_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'percentage', 0, ?, ?, ?, ?, ?)`);
// A product inserted is published to every sales channel (0122); some leave the feeds and AI agents.
const unpublishFromFeeds = insert(`UPDATE product_channel_publications SET unpublished_at = unixepoch() WHERE product_id = ? AND channel_id <> 'sc_online_store'`);
const insProductMedia = insert(`INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insOptionDef = insert(`INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insOptionValue = insert(`INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const insVariant = insert(`INSERT INTO product_variants (id, product_id, option_combination_key, image_id, weight, sku, price_minor, stock, reserved_stock, preorder_stock, is_default, track_inventory, version, stock_version, low_stock_threshold, discount_bps, discount_type, discount_amount_minor, barcode, barcode_type, created_at, updated_at, allow_backorder, backorder_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, ?, ?, 'percentage', 0, ?, ?, ?, ?, ?, ?)`);
const insVariantOption = insert(`INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES (?, ?, ?)`);
const insAttrValue = insert(`INSERT INTO product_attribute_values (id, product_id, attribute_id, value, created_at) VALUES (?, ?, ?, ?, ?)`);
const insCollection = insert(`INSERT INTO collections (id, name, description, presentation, config, sort_order, is_active, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`);
// Orders store the street line apart from their City/Thana/Area places, and the tax label
// checkout always writes ("VAT" when nothing was taxed), so saved money reads in the order's currency.
// Customers carry no address columns any more: a customer's first address is
// written by the orders_seed_customer_address trigger from the first shipping order.
const insCustomer = insert(`INSERT INTO customers (id, name, email, phone, total_orders, last_order_at, origin, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insOrder = insert(`INSERT INTO orders (id, order_number, customer_name, customer_phone, customer_email, shipping_address, city, zone, area, city_name, zone_name, area_name, shipping_method_kind, shipping_method_id, shipping_method_name, status, payment_method, payment_status, fulfillment_status, customer_id, currency_code, currency_decimal_places, tax_label, subtotal_amount_minor, shipping_amount_minor, total_amount_minor, paid_amount_minor, balance_due_minor, payment_terms_days, payment_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivery', ?, ?, ?, ?, ?, ?, ?, 'BDT', 2, 'VAT', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insShipFulfillment = insert(`INSERT INTO order_fulfillments (id, order_id, kind, status, request_key, actor_type, actor_id, created_at, location_id) VALUES (?, ?, 'ship', 'active', 'seed-0', 'system', NULL, ?, 'loc_default')`);
const insShipFulfillmentLine = insert(`INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const insOrderItem = insert(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, variant_label, inventory_tracked, unit_price_minor, line_subtotal_minor, taxable_amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
// Checkout snapshots the tax it applied with every order (commit-order.ts); the default
// profile's single market has no tax region, so each order and line snapshots "no tax".
const insOrderTaxSnapshot = insert(`INSERT INTO order_tax_snapshots (order_id, currency_code, decimal_places, display_label, prices_include_tax, shipping_taxed, settings_version, calculation_version, destination_snapshot, rate_snapshot, provider_id, address_source, created_at) VALUES (?, 'BDT', 2, 'VAT', 0, 0, 1, 'tax-v1', ?, ?, 'system', 'shipping', ?)`);
const insOrderItemTaxSnapshot = insert(`INSERT INTO order_item_tax_snapshots (order_item_id, order_id, tax_class_id, tax_class_name, prices_include_tax, rate_snapshot, country_code, tax_region_id, provider_id, created_at) VALUES (?, ?, NULL, NULL, 0, '[]', 'BD', NULL, 'system', ?)`);
function seedUntaxedSnapshot(orderId, itemIds, shippingMinor, destination, createdAt) {
  const shipping = { taxClassId: null, taxClassName: null, grossAmountMinor: shippingMinor, discountMinor: 0, taxableAmountMinor: shippingMinor, taxMinor: 0, totalMinor: shippingMinor, components: [] };
  insOrderTaxSnapshot.run(orderId, JSON.stringify(destination),
    JSON.stringify({ lines: itemIds.map((lineId) => ({ lineId, taxClassId: null, taxClassName: null, components: [] })), shipping }), createdAt);
  for (const itemId of itemIds) insOrderItemTaxSnapshot.run(itemId, orderId, createdAt);
}
// A COD order and its collection lifecycle are one durable fact (commit-order.ts writes the
// row with the order), so every seeded COD order carries its cod_tracking row.
const insCodTracking = insert(`INSERT INTO cod_tracking (id, order_id, delivery_attempts, last_attempt_at, cod_status, collected_by, collected_amount_minor, collected_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
/** The order's COD row: collected once cash is in, returned when it came back unpaid, else pending. */
function seedCodTracking(orderId, { status, paidMinor, shippedAt, collectedAt, collectedBy, createdAt, updatedAt }) {
  const codStatus = paidMinor > 0 ? "collected" : status === "returned" ? "returned" : "pending";
  const attempts = shippedAt === null ? 0 : 1;
  const collected = codStatus === "collected";
  insCodTracking.run(`cod_${orderId}`, orderId, attempts, attempts ? shippedAt : null, codStatus,
    collected ? collectedBy : null, collected ? paidMinor : null, collected ? collectedAt : null, createdAt, updatedAt);
}
/**
 * The delivery places every seeded Bangladesh order names (docs/PLACES.md): each
 * city in CITIES with three thanas of two areas, an "Inside Dhaka" zone (Dhaka)
 * and an "Outside Dhaka" zone (the rest), and one flat delivery rate per zone at
 * the fees the orders charge, named apart from its zone ("Inside Dhaka · City
 * rider (1-2 days)") as a merchant names them. Orders store the place ids, so editing a seeded
 * order's address or items resolves its City/Thana/Area like a checkout order's.
 */
const DELIVERY_RATE_NAMES = { inside: "City rider (1-2 days)", outside: "Courier (2-4 days)" };
function seedDeliveryPlaces() {
  const created = NOW - 900 * DAY;
  const insPlace = db.prepare("INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata, is_active, sort_order, created_at, updated_at) VALUES (?, 'BD', ?, ?, ?, '{}', '{}', 1, ?, ?, ?)");
  const insZone = db.prepare("INSERT INTO delivery_zones (id, name, revision, sort_order, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)");
  const insZoneLocation = db.prepare("INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES (?, ?)");
  const insRate = db.prepare("INSERT INTO shipping_methods (id, name, fee_minor, rate_source, is_active, sort_order, created_at, updated_at, zone_id, kind) VALUES (?, ?, ?, 'flat', 1, ?, ?, ?, ?, 'delivery')");
  const DHAKA_THANAS = ["Gulshan", "Dhanmondi", "Mirpur"];
  const placesByCity = new Map();
  tx(() => {
    insZone.run("dz_scale_inside", "Inside Dhaka", 0, created, created);
    insZone.run("dz_scale_outside", "Outside Dhaka", 1, created, created);
    insRate.run("sm_scale_inside", DELIVERY_RATE_NAMES.inside, 6000, 0, created, created, "dz_scale_inside");
    insRate.run("sm_scale_outside", DELIVERY_RATE_NAMES.outside, 12000, 1, created, created, "dz_scale_outside");
    CITIES.forEach((city, cityIndex) => {
      const cityId = `plc_scale_${pad(cityIndex, 2)}`;
      insPlace.run(cityId, 1, null, city, cityIndex, created, created);
      insZoneLocation.run(cityId, city === "Dhaka" ? "dz_scale_inside" : "dz_scale_outside");
      const thanas = (city === "Dhaka" ? DHAKA_THANAS : [`${city} Sadar`, "Kotwali", "Station Road"]).map((name, thanaIndex) => {
        const thanaId = `${cityId}_${thanaIndex}`;
        insPlace.run(thanaId, 2, cityId, name, thanaIndex, created, created);
        const areas = ["Block A", "Block B"].map((areaName, areaIndex) => {
          const areaId = `${thanaId}_${areaIndex}`;
          insPlace.run(areaId, 3, thanaId, `${name} ${areaName}`, areaIndex, created, created);
          return { id: areaId, name: `${name} ${areaName}` };
        });
        return { id: thanaId, name, areas };
      });
      placesByCity.set(city, { id: cityId, name: city, thanas });
    });
  });
  log(`delivery places: ${CITIES.length} cities, ${CITIES.length * 3} thanas, ${CITIES.length * 6} areas in 2 zones`);
  return placesByCity;
}
/** An order's City/Thana/Area ids and names, picked from the seeded places by a stable number. */
function deliveryLocation(placesByCity, cityName, pickNumber) {
  const city = placesByCity.get(cityName);
  const thana = city.thanas[pickNumber % city.thanas.length];
  const area = thana.areas[Math.floor(pickNumber / city.thanas.length) % thana.areas.length];
  return { city: city.id, zone: thana.id, area: area.id, cityName: city.name, zoneName: thana.name, areaName: area.name };
}
/** "Red / XL" per optioned SKU, axes in definition order; default SKUs have none. */
function variantLabels() {
  const rows = db.prepare(`SELECT vo.variant_id AS variant_id, group_concat(ov.value, ' / ') AS label
    FROM (SELECT variant_id, option_definition_id, option_value_id FROM product_variant_option_values ORDER BY variant_id, option_definition_id) AS vo
    JOIN product_option_values AS ov ON ov.id = vo.option_value_id GROUP BY vo.variant_id`).all();
  return new Map(rows.map((row) => [row.variant_id, row.label]));
}

// The huge seed writes millions of rows whose domain events would only flood
// the outbox queue; see the header for why dropping them for the run is safe.
if (HUGE) {
  dropEventTriggers();
  // A failure mid-run leaves a half-seeded state, but never one without its event triggers.
  process.on("uncaughtException", (error) => {
    console.error(error);
    try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
    try { console.error(`restored ${restoreTriggers()} event-outbox triggers after the failure; recreate the state before seeding again`); } catch (restoreError) { console.error("could not restore triggers; run --restore-triggers", restoreError); }
    process.exit(1);
  });
}

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
    for (const qualifier of sample(QUALIFIERS, PROFILE.qualifiersPerFamily)) {
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
    // The huge store keeps a few draft and trashed brands; products that point at
    // them stay public with the brand identity omitted.
    const brandDraft = HUGE && position % 53 === 17;
    const brandTrashed = HUGE && position % 97 === 41;
    insBrand.run(id, name, slug, brandDraft ? "draft" : "published", position, NOW - 900 * DAY, NOW - 900 * DAY, brandTrashed ? NOW - 30 * DAY : null);
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
const stats = { products: 0, simple: 0, optioned: 0, variants: 0, media: 0, attributeValues: 0 };
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

// The mega product: 100 SKUs on five merchant axes (5 x 5 x 2 x 2 x 1).
const MEGA_INDEX = 7;
const MEGA_AXES = [
  ["Color", ["Black", "White", "Blue", "Green", "Titanium"]],
  ["Storage", ["256GB", "512GB", "1TB", "2TB", "4TB"]],
  ["Material", ["Aluminium", "Carbon"]],
  ["Edition", ["Standard", "Pro"]],
  ["Condition", ["Brand new"]],
];
// Backorder policy: a few tracked SKUs keep selling past zero up to a limit
// (the rest of the zero-stock SKUs stay oversold-protected). Drawn from the
// huge stream only, so the default catalogue is unchanged.
function backorderPolicy(trackInventory) {
  if (!HUGE || !trackInventory || !hrng.chance(0.05)) return [0, 0];
  return [1, hrng.pick([10, 25, 50])];
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
  const bangla = chance(PROFILE.banglaRate);
  let name = productName(family, brand, index, bangla);
  if (HUGE) {
    // Edge names, by index so the default stream is untouched: a fully Bangla
    // product name, a 120+ character merchant name, and the mega product.
    if (bangla && index % 3 === 0) name = `${BANGLA_PRODUCT_NAMES[index % BANGLA_PRODUCT_NAMES.length]} ${brand}`;
    if (index % 331 === 5) name = padName(name, 130 + (index % 40), NAME_FILLER);
    if (index === MEGA_INDEX) name = "Ultimate Configurable Workstation Bundle";
  }
  const id = `prod_scale_${pad(index, 6)}`;
  const createdAt = NOW - int(0, 720) * DAY - int(0, DAY);
  const updatedAt = createdAt + int(0, 30) * DAY;
  const deletedAt = chance(0.01) ? updatedAt + DAY : null;
  const isActive = chance(0.95) ? 1 : 0;
  const basePrice = Math.round(int(family.price[0], family.price[1]) / 10) * 10;
  const discountBps = chance(0.25) ? pick([500, 1000, 1500, 2000]) : 0;
  const paragraphs = int(2, 6);
  const description = HUGE && index % 17 === 0 ? null : Array.from({ length: paragraphs }, (_, p) =>
    `<p>${name} ${p === 0 ? "comes with" : "also offers"} ${pick(QUALIFIERS).toLowerCase()} performance, ${pick(SPEC_VALUES.Warranty)} warranty and fast delivery across Bangladesh. ${bangla ? "সারা বাংলাদেশে হোম ডেলিভারি। " : ""}Model ${index} is available in official and unofficial variants.</p>`).join("");

  // Option shape: one family-defined shape per product; ~2% are large sets.
  const large = family.axes.length === 2 && chance(0.05);
  const optioned = (HUGE && index === MEGA_INDEX) || (family.axes.length > 0 && (large || chance(PROFILE.optionedRate)));
  let axes = [];
  if (optioned) {
    const axisCount = family.axes.length === 2 && (large || chance(0.5)) ? 2 : 1;
    axes = family.axes.slice(0, axisCount).map(([axisName, values]) => [
      axisName,
      large ? values : sample(values, Math.min(values.length, int(axisCount === 2 ? 2 : 3, axisCount === 2 ? 3 : 5))),
    ]);
  }
  if (HUGE && index === MEGA_INDEX) axes = MEGA_AXES;
  // Cartesian product, first axis outermost (the order the two-axis shape always had).
  const combos = axes.length === 0
    ? []
    : axes.reduce((acc, [, values]) => acc.flatMap((prefix) => values.map((value) => [...prefix, value])), [[]]);

  const variantPrices = combos.map((_, comboIndex) => basePrice + comboIndex * Math.round(basePrice * 0.05 / 100) * 100);
  const priceMinor = (optioned ? Math.min(...variantPrices) : basePrice) * 100;
  // Drawn in the order the seed always drew them, so the catalogue stays the same.
  const metaTitle = chance(0.3) ? `${name} Price in BD` : null;
  const noIndex = chance(0.01) ? 1 : 0;
  const excludeFromSitemap = chance(0.01) ? 1 : 0;
  const offFeeds = chance(0.02);
  const condition = chance(0.9) ? "new" : chance(0.5) ? "refurbished" : null;
  insProduct.run(id, name, description, priceMinor, category.id, `${slugify(name).slice(0, 80)}-${index}`,
    metaTitle, `Buy ${name} at the best price in Bangladesh.`, noIndex, excludeFromSitemap, condition,
    isActive, optioned ? 0 : discountBps, chance(0.05) ? 1 : 0, createdAt, updatedAt, deletedAt, brandIds.get(brand));
  if (offFeeds) unpublishFromFeeds.run(id);
  productRows.push({ id, name, optioned, deletedAt, isActive });

  // Media: 1-4 ready images, first is primary.
  let imageCount = int(1, 4);
  if (HUGE && index % 250 === 3) imageCount = 0; // no images at all
  if (HUGE && index % 2500 === 11) imageCount = 20; // a full gallery
  const productMediaIds = [];
  for (let m = 0; m < imageCount; m += 1) {
    const mediaId = `med_scale_${pad(index, 6)}_${m}`;
    int(20000, 400000); // the draw the seed always made (the size is now the placeholder's)
    insMedia.run(mediaId, `${slugify(name).slice(0, 60)}-${m}.webp`, `media/${mediaId}.webp`, PLACEHOLDER_IMAGE.length, `${name} image ${m + 1}`, createdAt, createdAt);
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

  // A SKU inserted with stock holds it at the default location (migration
  // 0102's SKU-insert trigger books the level once), so the seed writes no
  // stocktake movement and the SKU keeps its first stock version.
  if (!optioned) {
    const variantId = `var_scale_${pad(index, 6)}_d`;
    const trackInventory = chance(0.85) ? 1 : 0;
    const stock = trackInventory ? (chance(0.12) ? 0 : int(1, 250)) : 0;
    const barcode = chance(0.5) ? ean13(barcodeSerial++) : null;
    insVariant.run(variantId, id, null, null, chance(0.6) ? Number((rand() * 5).toFixed(2)) : null,
      `SC-${pad(index, 6)}`, priceMinor, stock, 1, trackInventory, 1, chance(0.3) ? 5 : null,
      0, barcode, barcode ? "ean13" : null, createdAt, updatedAt, ...backorderPolicy(trackInventory));
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
      variantPrices[comboIndex] * 100, stock, 0, trackInventory, 1, null,
      chance(0.2) ? pick([500, 1000]) : 0, barcode, barcode ? "ean13" : null, createdAt, updatedAt, ...backorderPolicy(trackInventory));
    selected.forEach((valueId, axisIndex) => insVariantOption.run(variantId, definitionIds[axisIndex], valueId));
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
      ? { source: "dynamic", categoryIds: sample(publishedCategories, int(1, 12)).map((category) => category.id), productIds: [], maxProducts: int(8, 24), title: `Top picks ${index}`, subtitle: "" }
      : { source: "manual", categoryIds: [], productIds: sample(liveProducts, int(8, 90)).map((row) => row.id), maxProducts: int(8, 24), title: `Featured ${index}`, subtitle: "" };
    const createdAt = NOW - (400 - index) * DAY;
    insCollection.run(`col_scale_${pad(index, 3)}`, `${dynamic ? "Best of" : "Featured"} ${pick(FAMILIES).name} ${index}`, null,
      index % 3 === 0 ? "carousel" : "grid", JSON.stringify(config), index, createdAt, createdAt);
  }
});
log(`collections: ${COLLECTIONS}`);

// ================================================================ huge profile
// Customers, markets, staff, promotions, a million orders with their payments,
// fulfilments, returns, refunds, reviews, inbox threads, gift cards,
// notification history and audit events. Everything goes through the real
// triggers (fulfilment projections, customer stats, FTS, cache dependencies,
// review stats, gift-card balances); only the event outbox is skipped.
const hugeCounts = {};
function seedHuge() {
  const clock = buildClock(NOW, PROFILE.orderWindowDays);
  const hsha = (value) => createHash("sha256").update(value).digest("hex");
  const bangla = (p) => hrng.chance(p);

  // ------------------------------------------------------------- staff users
  const STAFF_FIRST = ["Nabil", "Shirin", "Rafiq", "Tahmina", "Kamrul", "Lamia", "Jahid", "Sharmin", "Mamun", "Poly", "Anika", "Zubair", "Moushumi", "Sohel", "Rima"];
  const staffIds = [];
  tx(() => {
    const insUser = db.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin, banned, ban_reason, created_at, updated_at) VALUES (?, ?, ?, 1, 'admin', 0, ?, ?, ?, ?)");
    for (let k = 0; k < PROFILE.staff; k += 1) {
      const id = `usr_staff_${pad(k, 2)}`;
      const created = NOW - (900 - k * 40) * DAY;
      const banned = k === PROFILE.staff - 1; // one former employee
      insUser.run(id, `${STAFF_FIRST[k % STAFF_FIRST.length]} ${pick(LAST)}`, `staff${pad(k + 1, 2)}@example.test`, banned ? 1 : 0, banned ? "Left the company" : null, created, created);
      staffIds.push(id);
    }
  });
  const activeStaff = staffIds.slice(0, -1);
  log(`staff: ${staffIds.length}`);

  // ------------------------------------------------------------------ markets
  // Backup market is Bangladesh (BDT). Two foreign-currency markets, priced at
  // a manual FX rate (market units per shop unit); an order's rate is the inverse.
  const MARKETS = [
    { id: "mkt_backup", code: "BD", currency: "BDT", rate: "1", orderRate: "1", taxBps: 500, taxLabel: "VAT 5%", taxShare: 0.25 },
    { id: "mkt_scale_us", code: "US", currency: "USD", rate: "0.0082", orderRate: invertRate("0.0082"), taxBps: 0, taxLabel: null, taxShare: 0 },
    { id: "mkt_scale_eu", code: "DE", currency: "EUR", rate: "0.0076", orderRate: invertRate("0.0076"), taxBps: 2000, taxLabel: "VAT 20%", taxShare: 1 },
  ];
  tx(() => {
    const insMarket = db.prepare("INSERT INTO markets (id, handle, name, status, is_backup, price_mode, fx_rate, price_adjustment_bps, currency_code, fx_rate_as_of, fx_lock_minutes, fx_rate_source, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, 'fx', ?, 0, ?, ?, 30, 'manual', ?, ?)");
    const insCountry = db.prepare("INSERT INTO market_countries (country_code, market_id, created_at) VALUES (?, ?, ?)");
    const insPresence = db.prepare("INSERT INTO market_presences (id, market_id, kind, value, locale, created_at) VALUES (?, ?, 'subfolder', ?, 'en', ?)");
    const created = NOW - 400 * DAY;
    insMarket.run("mkt_scale_us", "united-states", "United States", "0.0082", "USD", NOW - 2 * DAY, created, created);
    insCountry.run("US", "mkt_scale_us", created);
    insPresence.run("mkp_scale_us", "mkt_scale_us", "en-us", created);
    insMarket.run("mkt_scale_eu", "europe", "Europe", "0.0076", "EUR", NOW - 2 * DAY, created, created);
    for (const country of ["DE", "FR", "NL", "IT", "ES"]) insCountry.run(country, "mkt_scale_eu", created);
    insPresence.run("mkp_scale_eu", "mkt_scale_eu", "en-eu", created);
  });
  log("markets: 3 (BDT backup, USD, EUR)");

  // --------------------------------------------------------------- customers
  const customers = [];
  const LONG_NAME_FILLER = ["bin", "Abdul", "Mohammad", "Sheikh", "Chowdhury", "Hossain", "Rahman", "Khandaker", "Mojumder", "Siddique"];
  const insertCustomerBatch = (from, to) => tx(() => {
    for (let index = from; index < to; index += 1) {
      const id = `cus_scale_${pad(index, 6)}`;
      const whale = index === 0;
      const foreignKind = !whale && index % 125 === 3 ? (index % 250 === 3 ? 1 : 2) : 0;
      const isBangla = foreignKind === 0 && bangla(0.2);
      let name = isBangla ? `${hrng.pick(BANGLA_FIRST)} ${hrng.pick(BANGLA_LAST)}` : `${pick(FIRST)} ${pick(LAST)}`;
      if (whale) name = "Mahmudul Hasan Chowdhury";
      if (index % 4001 === 9) name = padName(name, 125, LONG_NAME_FILLER);
      const city = foreignKind === 1 ? "San Francisco" : foreignKind === 2 ? "Berlin" : pick(CITIES);
      const createdAt = whale ? NOW - (PROFILE.orderWindowDays - 2) * DAY : Math.min(NOW - 3600, sampleTime(hrng, clock));
      // Phone is required for Bangladesh; an international digital-style buyer may have only an email (NO_PHONE is "").
      const phone = foreignKind === 1 && index % 500 === 3 ? "" : foreignKind === 0 ? `+88017${pad(index, 8)}` : foreignKind === 1 ? `+1555${pad(index, 7)}` : `+49151${pad(index, 7)}`;
      const email = foreignKind || phone === "" ? `intl${index}@example.test` : hrng.chance(0.6) ? `customer${index}@example.test` : null;
      const deletedAt = index > 40 && hrng.chance(0.003) ? Math.min(NOW - 60, createdAt + 90 * DAY) : null;
      insCustomer.run(id, name, email, phone, 0, null, hrng.chance(0.15) ? "merchant" : "order", createdAt, createdAt, deletedAt);
      customers.push({
        id, name, phone, email, city, createdAt, market: foreignKind, bangla: isBangla,
        area: isBangla ? hrng.pick(BANGLA_AREAS) : hrng.pick(AREAS),
        house: hrng.int(1, 200), road: hrng.int(1, 30), whatsapp: hrng.chance(0.15),
      });
    }
  });
  for (let from = 0; from < CUSTOMERS; from += 10000) {
    insertCustomerBatch(from, Math.min(CUSTOMERS, from + 10000));
    if (from % 50000 === 40000) log(`customers: ${from + 10000}`);
  }
  log(`customers: ${CUSTOMERS}`);

  // -------------------------------------------------------------- promotions
  const insPromotion = db.prepare("INSERT INTO promotions (id, name, title, method, status, priority, starts_at, ends_at, timezone, revision, created_at, updated_at, deleted_at, combines_with_product_discounts) VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, 'Asia/Dhaka', 1, ?, ?, NULL, ?)");
  const insEffect = db.prepare("INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)");
  const insCondition = db.prepare("INSERT INTO promotion_conditions (id, promotion_id, kind, config, position, created_at) VALUES (?, ?, ?, ?, 0, ?)");
  const insCode = db.prepare("INSERT INTO promotion_codes (id, promotion_id, code, normalized_code, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const PROMO_NAMES = ["Eid Mega Sale", "Weekend Flash", "New Customer Welcome", "Black Friday", "11.11 Campaign", "Laptop Fest", "Free Delivery Week", "Winter Clearance", "Back to School", "Brand Day"];
  const promos = [];
  tx(() => {
    for (let k = 0; k < PROFILE.promotions; k += 1) {
      const id = `promo_scale_${pad(k, 5)}`;
      const method = k % 20 < 13 ? "code" : "automatic";
      const kindRoll = k % 20;
      const effectKind = kindRoll % 5 === 4 ? "free" : kindRoll % 4 === 3 ? "fixed_amount_off" : "percentage_off";
      const target = effectKind === "percentage_off" ? "line" : effectKind === "free" ? "shipping" : "order";
      const bps = effectKind === "percentage_off" ? hrng.pick([500, 1000, 1500, 2000, 2500]) : 0;
      const created = NOW - hrng.int(30, 1000) * DAY;
      const name = `${hrng.pick(PROMO_NAMES)} ${effectKind === "percentage_off" ? `${bps / 100}% off` : effectKind === "free" ? "free shipping" : "flat discount"} #${k}`;
      insPromotion.run(id, name, hrng.chance(0.6) ? name.slice(0, 120) : null, method, hrng.int(1, 200), created, created, hrng.chance(0.3) ? 1 : 0);
      const effectId = `peff_scale_${pad(k, 5)}`;
      const config = effectKind === "percentage_off" ? JSON.stringify({ basisPoints: bps }) : effectKind === "fixed_amount_off" ? JSON.stringify({ amountMinor: hrng.pick([20000, 50000, 100000, 200000]), currencyCode: "BDT" }) : "{}";
      insEffect.run(effectId, id, effectKind, target, target === "line" ? "across" : "once", config, created);
      if (hrng.chance(0.5)) {
        if (hrng.chance(0.6)) insCondition.run(`pcon_scale_${pad(k, 5)}`, id, "minimum_merchandise_subtotal", JSON.stringify({ amountMinor: hrng.pick([100000, 300000, 500000, 1000000]), currencyCode: "BDT" }), created);
        else insCondition.run(`pcon_scale_${pad(k, 5)}`, id, "minimum_item_quantity", JSON.stringify({ quantity: hrng.int(2, 5) }), created);
      }
      const codes = [];
      if (method === "code") {
        const count = hrng.int(1, 3);
        for (let c = 0; c < count; c += 1) {
          const code = `${["SAVE", "EID", "WELCOME", "FEST", "VIP"][c % 5]}${pad(k, 5)}${c ? `-${c}` : ""}`;
          insCode.run(`pcode_scale_${pad(k, 5)}_${c}`, id, code, code, c === 2 ? 0 : 1, created);
          codes.push(code);
        }
      }
      promos.push({ id, name, method, effectKind, target, bps, effectId, codes, used: 0, usedMinor: 0, created });
    }
  });
  const codePromos = promos.filter((promo) => promo.method === "code" && promo.effectKind === "percentage_off");
  const autoPromos = promos.filter((promo) => promo.method === "automatic" && promo.effectKind === "percentage_off");
  log(`promotions: ${promos.length} (${codePromos.length} redeemable code, ${autoPromos.length} automatic percentage)`);

  // ------------------------------------------------------------ order catalog
  const labels = variantLabels();
  const variants = db.prepare(`SELECT v.id AS id, v.product_id AS product_id, v.price_minor AS price, v.discount_bps AS bps, v.track_inventory AS tracked,
      p.name AS pname, p.is_active AS active, p.deleted_at AS pdel, pm.media_id AS media_id
    FROM product_variants AS v JOIN products AS p ON p.id = v.product_id
    LEFT JOIN product_media AS pm ON pm.product_id = p.id AND pm.is_primary = 1
    WHERE v.deleted_at IS NULL ORDER BY v.id`).all().map((row) => ({
    id: row.id, productId: row.product_id, name: row.pname, tracked: row.tracked ? 1 : 0, mediaId: row.media_id,
    label: labels.get(row.id) ?? null, list: row.price,
    eff: row.bps > 0 ? divRoundLocal(row.price * (10000 - row.bps), 10000) : row.price,
    sellable: row.active === 1 && row.pdel === null,
  }));
  const sellable = variants.filter((variant) => variant.sellable);
  log(`order catalog: ${variants.length} SKUs (${sellable.length} sellable)`);

  // ------------------------------------------------------------------ orders
  // Column list with literals ("name=value"), so placeholders can never drift from columns.
  const prepareInsert = (table, columns) => db.prepare(`INSERT INTO ${table} (${columns.map((column) => column.split("=")[0]).join(", ")}) VALUES (${columns.map((column) => (column.includes("=") ? column.split("=").slice(1).join("=") : "?")).join(", ")})`);
  const insOrderHuge = prepareInsert("orders", ["id", "order_number", "customer_name", "customer_phone", "customer_email", "customer_whatsapp",
    "shipping_address", "shipping_country_code", "city", "zone", "area", "city_name", "zone_name", "area_name", "shipping_name", "shipping_phone", "shipping_locality", "shipping_admin_area", "shipping_postal_code", "billing_same_as_shipping=1",
    "status", "payment_method", "payment_status", "fulfillment_status", "customer_id", "market_id",
    "currency_code", "currency_decimal_places=2", "subtotal_amount_minor", "shipping_amount_minor", "discount_amount_minor", "tax_amount_minor", "tax_label", "total_amount_minor", "paid_amount_minor", "balance_due_minor",
    "shop_currency", "fx_rate", "fx_source", "fx_as_of", "fx_locked_until", "subtotal_shop_minor", "shipping_shop_minor", "discount_shop_minor", "tax_shop_minor", "total_shop_minor",
    "channel", "shipping_method_kind='delivery'", "shipping_method_id", "shipping_method_name", "notes", "archived_at", "deleted_at", "created_at", "updated_at"]);
  // Checkout snapshots the tax it applied with every order (commit-order.ts): the market's
  // one VAT rate on each taxed line, or no components when the order was not taxed.
  const insTaxSnapshotHuge = db.prepare(`INSERT INTO order_tax_snapshots (order_id, currency_code, decimal_places, display_label, prices_include_tax, shipping_taxed, settings_version, calculation_version, destination_snapshot, rate_snapshot, provider_id, address_source, created_at)
    VALUES (?, ?, 2, ?, 0, 0, 1, 'tax-v1', ?, ?, 'system', 'shipping', ?)`);
  const insItemTaxSnapshotHuge = db.prepare(`INSERT INTO order_item_tax_snapshots (order_item_id, order_id, tax_class_id, tax_class_name, prices_include_tax, rate_snapshot, country_code, tax_region_id, provider_id, created_at)
    VALUES (?, ?, NULL, NULL, 0, ?, ?, NULL, 'system', ?)`);
  const insItemHuge = db.prepare(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, variant_label, inventory_tracked, unit_price_minor, base_unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor, product_image_media_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insPayment = db.prepare(`INSERT INTO order_payments (id, order_id, currency, payment_method, payment_type, status, cod_collected_by, cod_collected_at, metadata, created_at, updated_at, provider_ref, amount_minor, settlement_currency, settlement_amount_minor, settlement_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insFulfillment = db.prepare("INSERT INTO order_fulfillments (id, order_id, kind, status, request_key, actor_type, actor_id, created_at, location_id) VALUES (?, ?, 'ship', 'active', ?, 'admin', ?, ?, 'loc_default')");
  const insFulfillmentLine = db.prepare("INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const insReturn = db.prepare(`INSERT INTO order_returns (id, order_id, status, reason, notes, actor_type, actor_id, source, requested_at, approved_at, receiving_started_at, completed_at, rejected_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insReturnLine = db.prepare(`INSERT INTO order_return_lines (id, return_id, order_id, order_item_id, variant_id, inventory_tracked, requested_quantity, approved_quantity, received_quantity, restock_quantity, damaged_quantity, rejected_quantity, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insEvent = db.prepare("INSERT INTO order_events (id, order_id, kind, body, data, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insAllocation = db.prepare(`INSERT INTO order_discount_allocations (id, order_id, order_item_id, promotion_id, effect_id, promotion_revision, evaluator_version, method, promotion_name, promotion_code, effect_kind, target, currency_code, base_amount_minor, discount_amount_minor, quantity, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'percentage_off', 'line', ?, ?, ?, ?, ?)`);
  const insRedemption = db.prepare("INSERT INTO promotion_redemptions (id, promotion_id, order_id, customer_id, promotion_revision, promotion_code, currency_code, discount_amount_minor, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)");
  const insReview = db.prepare(`INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, customer_id, author_type, author_display_name, variant_label, rating, title, body, status, moderation_reason, published_at, reply_body, reply_user_id, replied_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'customer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insOutbox = db.prepare(`INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, order_id, audience, notification_type, source, payload, status, attempts, next_attempt_at, last_error, queued_at, sent_at, created_at, updated_at)
    VALUES (?, ?, 'order', ?, ?, 'customer', ?, 'seed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insReceipt = db.prepare(`INSERT INTO notification_delivery_receipts (id, receipt_key, outbox_id, subject_type, subject_id, order_id, notification_type, channel, provider, recipient_hash, recipient_masked, status, attempts, next_attempt_at, last_attempt_at, accepted_at, delivered_at, failed_at, last_error, created_at, updated_at)
    VALUES (?, ?, ?, 'order', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const pickCustomer = createCustomerPicker(hrng, { customers: CUSTOMERS, orders: ORDERS });
  const BIG_ORDER = Math.floor(ORDERS / 2);
  const reviewRate = PROFILE.reviews / (1.7 * ORDERS);
  const convTarget = Math.floor(PROFILE.conversations * 0.55);
  const convOrderRate = Math.min(1, (convTarget * 1.2) / ORDERS);
  const convOrders = [];
  const giftOrders = [];
  const reviewKeys = new Set();
  const totals = { orders: 0, items: 0, payments: 0, fulfillments: 0, fulfillmentLines: 0, returns: 0, returnLines: 0, events: 0, reviews: 0, allocations: 0, redemptions: 0, outbox: 0, receipts: 0, byStatus: {}, foreign: 0, archived: 0, trashed: 0 };
  const LINE_COUNT = [[1, 45], [2, 30], [3, 15], [4, 7], [5, 3]];
  const QTY = [[1, 70], [2, 20], [3, 7], [4, 2], [6, 1]];
  const NOTES = ["Please call before delivery.", "Leave with the guard.", "Gift wrap please.", "Deliver after 6pm.", "বিকালে ডেলিভারি দিন।"];

  function seedOrder(i) {
    const c = customers[pickCustomer(i)];
    const market = MARKETS[c.market];
    const orderId = `ord_scale_${pad(i, 7)}`;
    const orderNumber = 100000 + i;
    let ts = sampleTime(hrng, clock);
    if (ts < c.createdAt) ts = Math.min(NOW - 60, c.createdAt + hrng.int(0, 3 * DAY));
    const ageDays = Math.floor((NOW - ts) / DAY);
    const online = c.market !== 0 || hrng.chance(0.35);
    const method = c.market !== 0 ? "stripe" : online ? "sslcommerz" : "cod";

    // Lines: popularity-skewed distinct SKUs; one order carries 99 lines.
    const lineTarget = i === BIG_ORDER ? 99 : hrng.weighted(LINE_COUNT);
    const chosen = [];
    const seen = new Set();
    for (let guard = 0; chosen.length < lineTarget && guard < lineTarget * 20; guard += 1) {
      const variant = hrng.chance(0.9) ? sellable[popularIndex(hrng, sellable.length)] : variants[hrng.int(0, variants.length - 1)];
      if (seen.has(variant.id)) continue;
      seen.add(variant.id);
      chosen.push(variant);
    }
    const convert = (minor) => (c.market === 0 ? minor : Math.max(1, convertMinor(minor, market.rate)));
    const linesIn = chosen.map((variant) => ({ variant, unit: convert(variant.eff), list: convert(variant.list), qty: i === BIG_ORDER ? 1 : hrng.weighted(QTY) }));
    const life = pickLifecycle(hrng, ageDays, online);
    const cancelled = life.status === "cancelled";
    // A single one-unit line cannot be partly fulfilled.
    if (life.fulfillment === "partial" && linesIn.length === 1 && linesIn[0].qty === 1) life.fulfillment = "complete";
    const shippingShop = c.market === 0 ? hrng.weighted([[0, 15], [6000, 45], [12000, 40]]) : c.market === 1 ? 250000 : 220000;
    const shipping = c.market === 0 ? shippingShop : convertMinor(shippingShop, market.rate);

    // Discount: a code promotion (redeemed) or an automatic one, never on cancelled orders.
    let promo = null;
    let promoMethod = null;
    if (!cancelled && codePromos.length && hrng.chance(0.07)) { promo = codePromos[hrng.int(0, codePromos.length - 1)]; promoMethod = "code"; }
    else if (!cancelled && autoPromos.length && hrng.chance(0.04)) { promo = autoPromos[hrng.int(0, autoPromos.length - 1)]; promoMethod = "automatic"; }
    const taxBps = hrng.chance(market.taxShare) ? market.taxBps : 0;
    let priced = priceOrder({ lines: linesIn, shipping, discountBps: promo ? promo.bps : 0, taxBps });
    if (promo && priced.discount === 0) { promo = null; priced = priceOrder({ lines: linesIn, shipping, discountBps: 0, taxBps }); }
    const total = priced.total;
    const toShop = (minor) => (c.market === 0 ? minor : convertMinor(minor, market.orderRate));
    const subtotalShop = toShop(priced.subtotal);
    const shippingShopMinor = toShop(priced.shipping);
    const discountShop = toShop(priced.discount);
    const taxShop = toShop(priced.tax);
    const totalShop = subtotalShop - discountShop + taxShop + shippingShopMinor;

    // Timeline.
    const shipTs = Math.min(NOW - 120, ts + hrng.int(1, 3) * DAY + hrng.int(0, DAY));
    const deliveredTs = Math.min(NOW - 60, shipTs + hrng.int(1, 5) * DAY);
    const paidTs = online ? ts + hrng.int(10, 300) : deliveredTs;

    // Returns and refunds.
    let ret = null;
    if (life.fullReturn) ret = { full: true, status: online ? "completed" : hrng.weighted([["completed", 75], ["approved", 25]]) };
    else if (life.partialReturn) ret = { full: false, status: hrng.weighted([["completed", 70], ["requested", 15], ["approved", 10], ["rejected", 5]]) };
    let captured = 0;
    let refunded = 0;
    if (life.payment === "paid" || life.payment === "refunded") captured = total;
    else if (life.payment === "partial") captured = Math.max(1, Math.floor((total * 3) / 10));
    if (life.payment === "refunded" && (cancelled || (ret && ret.status === "completed"))) refunded = total;
    let returnLines = [];
    if (ret) {
      if (ret.full) returnLines = linesIn.map((line, k) => ({ k, qty: line.qty }));
      else {
        const k = hrng.int(0, linesIn.length - 1);
        returnLines = [{ k, qty: Math.max(1, Math.floor(linesIn[k].qty / 2)) }];
      }
      if (ret.status === "completed" && captured > 0 && refunded === 0) {
        refunded = ret.full ? captured : returnLines.reduce((sum, rl) => {
          const line = priced.lines[rl.k];
          return sum + divRoundLocal((line.subtotal - line.discount + line.tax) * rl.qty, line.qty);
        }, 0);
        refunded = Math.min(refunded, captured);
      }
    }
    const ledger = paymentLedgerState({ total, captured, refunded });
    const paymentStatus = life.payment === "failed" ? "failed" : ledger.status;
    const paid = ledger.paid;
    const balance = cancelled ? 0 : ledger.balance;

    let updatedAt = ts + hrng.int(60, 3600);
    if (life.fulfillment !== "pending") updatedAt = Math.max(updatedAt, shipTs);
    if (life.delivered) updatedAt = Math.max(updatedAt, deliveredTs);
    const retTs = Math.min(NOW - 30, deliveredTs + hrng.int(2, 12) * DAY);
    if (ret) updatedAt = Math.max(updatedAt, retTs);
    const trashed = hrng.chance(0.004);
    const archived = !trashed && (life.status === "completed" || life.status === "cancelled") && ageDays > 60 && hrng.chance(0.12);
    const deletedAt = trashed ? Math.min(NOW - 10, updatedAt + 2 * DAY) : null;
    const archivedAt = archived ? Math.min(NOW - 10, updatedAt + 20 * DAY) : null;
    if (trashed) totals.trashed += 1;
    if (archived) totals.archived += 1;
    const location = c.market === 0 ? deliveryLocation(PLACES_BY_CITY, c.city, c.house)
      : { city: null, zone: null, area: null, cityName: null, zoneName: null, areaName: null };
    const address = c.market === 0
      ? (c.bangla ? `বাসা ${c.house}, রোড ${c.road}` : `House ${c.house}, Road ${c.road}`)
      : `${c.house} ${c.market === 1 ? "Market St" : "Hauptstrasse"}`;
    insOrderHuge.run(orderId, orderNumber, c.name, c.phone, c.email, c.whatsapp && c.phone ? c.phone : null,
      address, market.code, location.city, location.zone, location.area, location.cityName, location.zoneName, location.areaName,
      c.name, c.phone || null, c.market === 0 ? null : c.city, c.market === 1 ? "CA" : null, c.market === 1 ? "94107" : c.market === 2 ? "10115" : null,
      life.status, method, paymentStatus, life.fulfillment, c.id, market.id,
      market.currency, priced.subtotal, priced.shipping, priced.discount, priced.tax, taxBps > 0 ? market.taxLabel : "VAT", total, paid, balance,
      "BDT", c.market === 0 ? "1" : market.orderRate, c.market === 0 ? "same_currency" : "manual", c.market === 0 ? null : ts, c.market === 0 ? null : ts + 1800,
      subtotalShop, shippingShopMinor, discountShop, taxShop, totalShop,
      hrng.chance(0.08) ? "admin" : "online_store", c.market === 0 ? (c.city === "Dhaka" ? "sm_scale_inside" : "sm_scale_outside") : null,
      c.market === 0 ? (priced.shipping === 0 ? "Free delivery" : c.city === "Dhaka" ? DELIVERY_RATE_NAMES.inside : DELIVERY_RATE_NAMES.outside) : "International delivery",
      hrng.chance(0.06) ? hrng.pick(NOTES) : null, archivedAt, deletedAt, ts, updatedAt);
    totals.orders += 1;
    totals.byStatus[life.status] = (totals.byStatus[life.status] ?? 0) + 1;
    if (c.market !== 0) totals.foreign += 1;

    const itemIds = [];
    priced.lines.forEach((line, k) => {
      const variant = linesIn[k].variant;
      const itemId = `oi_scale_${pad(i, 7)}_${k}`;
      itemIds.push(itemId);
      insItemHuge.run(itemId, orderId, variant.productId, variant.id, line.qty, variant.name, variant.label, variant.tracked,
        line.unit, linesIn[k].list, line.subtotal, line.discount, line.taxable, line.tax, variant.mediaId, ts);
      totals.items += 1;
    });
    const taxComponents = (amountMinor) => (taxBps > 0
      ? [{ rateId: `txr_scale_${market.code.toLowerCase()}`, name: market.taxLabel, rateBps: taxBps, priority: 0, compound: false, jurisdictionType: "all", jurisdictionId: null, amountMinor }]
      : []);
    const shippingTax = { taxClassId: null, taxClassName: null, grossAmountMinor: priced.shipping, discountMinor: 0, taxableAmountMinor: priced.shipping, taxMinor: 0, totalMinor: priced.shipping, components: [] };
    insTaxSnapshotHuge.run(orderId, market.currency, market.taxLabel ?? "VAT", JSON.stringify(location),
      JSON.stringify({ lines: priced.lines.map((line, k) => ({ lineId: itemIds[k], taxClassId: null, taxClassName: null, components: taxComponents(line.tax) })), shipping: shippingTax }), ts);
    priced.lines.forEach((line, k) => insItemTaxSnapshotHuge.run(itemIds[k], orderId, JSON.stringify(taxComponents(line.tax)), market.code, ts));

    // Discount allocations and the redemption of a code promotion.
    if (promo) {
      let allocated = 0;
      priced.lines.forEach((line, k) => {
        if (line.discount <= 0) return;
        insAllocation.run(`oda_scale_${pad(i, 7)}_${k}`, orderId, itemIds[k], promo.id, promo.effectId, promoMethod, promo.name.slice(0, 160),
          promoMethod === "code" ? promo.codes[0] : null, market.currency, line.subtotal, line.discount, line.qty, ts);
        allocated += line.discount;
        totals.allocations += 1;
      });
      if (promoMethod === "code") {
        insRedemption.run(`pred_scale_${pad(i, 7)}`, promo.id, orderId, c.id, promo.codes[0], market.currency, allocated, ts);
        totals.redemptions += 1;
      }
      promo.used += 1;
      promo.usedMinor += allocated;
    }

    // Fulfilment: every shipped order has an active shipping fulfilment; some
    // are split in two, and some shipped orders are only partly fulfilled.
    const fulfilledQty = priced.lines.map(() => 0);
    if (life.fulfillment !== "pending") {
      const groups = [];
      if (life.fulfillment === "partial") {
        // Several lines: the first half ships. One line of several units: all but one unit ships.
        if (priced.lines.length > 1) groups.push(priced.lines.map((line, k) => ({ k, qty: line.qty })).slice(0, Math.ceil(priced.lines.length / 2)));
        else groups.push([{ k: 0, qty: priced.lines[0].qty - 1 }]);
      } else if (priced.lines.length > 1 && hrng.chance(0.06)) {
        const cut = hrng.int(1, priced.lines.length - 1);
        const all = priced.lines.map((line, k) => ({ k, qty: line.qty }));
        groups.push(all.slice(0, cut), all.slice(cut));
      } else groups.push(priced.lines.map((line, k) => ({ k, qty: line.qty })));
      groups.forEach((group, g) => {
        const fulfillmentId = `ful_scale_${pad(i, 7)}_${g}`;
        const at = Math.min(NOW - 90, shipTs + g * 3600);
        insFulfillment.run(fulfillmentId, orderId, `seed-${g}`, activeStaff[(i + g) % activeStaff.length], at);
        totals.fulfillments += 1;
        group.forEach((part) => {
          insFulfillmentLine.run(`fln_scale_${pad(i, 7)}_${g}_${part.k}`, fulfillmentId, orderId, itemIds[part.k], part.qty, at);
          fulfilledQty[part.k] += part.qty;
          totals.fulfillmentLines += 1;
        });
      });
    }

    // Payments (the ledger the order's paid amount is derived from).
    const settle = (amount) => (c.market === 0 ? ["BDT", amount, "1"] : ["BDT", convertMinor(amount, market.orderRate), market.orderRate]);
    const payRow = (suffix, type, status, amount, at, ref) => {
      const [settlementCurrency, settlementAmount, settlementRate] = settle(amount);
      const collected = method === "cod" && status === "succeeded" && type !== "refund";
      insPayment.run(`pay_scale_${pad(i, 7)}_${suffix}`, orderId, market.currency, method, type, status,
        collected ? activeStaff[i % activeStaff.length] : null, collected ? at : null, type === "refund" ? JSON.stringify({ reason: "seed" }) : null,
        at, at, ref, amount, settlementCurrency, settlementAmount, settlementRate);
      totals.payments += 1;
    };
    if (captured > 0) payRow("a", life.payment === "partial" ? "deposit" : "full", "succeeded", captured, paidTs, method === "cod" ? null : `${method}_${orderNumber}`);
    else if (cancelled) payRow("a", "full", "cancelled", total, ts + 60, null);
    else if (life.payment === "failed") payRow("a", "full", "failed", total, ts + 60, method === "cod" ? null : `${method}_${orderNumber}`);
    else payRow("a", "full", "pending", total, ts + 60, method === "cod" ? null : `${method}_${orderNumber}`);
    if (refunded > 0) payRow("r", "refund", "refunded", refunded, Math.min(NOW - 5, ret ? retTs + DAY : ts + 2 * DAY), null);
    if (method === "cod") {
      seedCodTracking(orderId, { status: life.status, paidMinor: captured, shippedAt: life.fulfillment === "pending" ? null : shipTs,
        collectedAt: paidTs, collectedBy: activeStaff[i % activeStaff.length], createdAt: ts, updatedAt });
    }

    // Returns.
    if (ret) {
      const retId = `ret_scale_${pad(i, 7)}`;
      const fromCustomer = hrng.chance(0.4);
      const approvedAt = ret.status === "requested" ? null : Math.min(NOW - 20, retTs + 3600);
      const completedAt = ret.status === "completed" ? Math.min(NOW - 10, retTs + 4 * DAY) : null;
      insReturn.run(retId, orderId, ret.status, hrng.pick(RETURN_REASONS), hrng.chance(0.3) ? "Customer sent photos." : null,
        fromCustomer ? "customer" : "admin", fromCustomer ? null : activeStaff[i % activeStaff.length], fromCustomer ? "customer" : "admin",
        retTs, ret.status === "rejected" ? null : approvedAt, ret.status === "completed" ? completedAt - 86400 : null, completedAt,
        ret.status === "rejected" ? approvedAt : null, retTs, completedAt ?? approvedAt ?? retTs);
      totals.returns += 1;
      returnLines.forEach((rl) => {
        const q = Math.min(rl.qty, fulfilledQty[rl.k]);
        if (q <= 0) return;
        const approved = ret.status === "approved" || ret.status === "completed" ? q : 0;
        const received = ret.status === "completed" ? q : 0;
        insReturnLine.run(`retl_scale_${pad(i, 7)}_${rl.k}`, retId, orderId, itemIds[rl.k], linesIn[rl.k].variant.id, linesIn[rl.k].variant.tracked,
          q, approved, received, 0, received, ret.status === "rejected" ? q : 0, null, retTs, retTs);
        totals.returnLines += 1;
      });
    }

    // Timeline events (a third of orders, and every return, cancellation and refund).
    if (hrng.chance(PROFILE.eventRate) || ret || cancelled) {
      const actor = activeStaff[i % activeStaff.length];
      const events = [];
      if (life.status !== "pending") events.push(["status_changed", null, { from: "pending", to: cancelled ? "cancelled" : "confirmed" }, ts + hrng.int(300, 7200)]);
      if (life.fulfillment !== "pending") events.push(["shipment_created", null, { courier: hrng.pick(["pathao", "steadfast"]) }, shipTs]);
      if (life.delivered) events.push(["status_changed", null, { from: "shipped", to: life.status }, deliveredTs]);
      if (life.delivered && method === "cod" && paid > 0) events.push(["cod_collected", null, { amountMinor: paid }, deliveredTs + 60]);
      if (ret) events.push(["return_created", null, { returnId: `ret_scale_${pad(i, 7)}` }, retTs]);
      if (refunded > 0) events.push(["refund_recorded", null, { amountMinor: refunded }, retTs + DAY]);
      if (hrng.chance(0.15)) events.push(["comment", hrng.pick(["Called the customer, confirmed address.", "Customer asked for a faster courier.", "Held for stock check."]), null, ts + hrng.int(600, 86400)]);
      events.forEach(([kind, body, data, at], k) => {
        insEvent.run(`oev_scale_${pad(i, 7)}_${k}`, orderId, kind, body, data ? JSON.stringify(data) : null, kind === "comment" || kind === "return_created" ? actor : null, Math.min(NOW - 1, at));
        totals.events += 1;
      });
    }

    // Notification history for a share of orders (no PII: masked recipient, hashed key).
    if (hrng.chance(PROFILE.notificationRate)) {
      const outboxId = `nob_scale_${pad(i, 7)}`;
      const failed = hrng.chance(0.06);
      const type = life.fulfillment !== "pending" && hrng.chance(0.5) ? "order.shipped" : "order.placed";
      const at = ts + hrng.int(5, 120);
      insOutbox.run(outboxId, `order:${orderId}:${type}:customer`, orderId, orderId, type, JSON.stringify({ orderId, type }),
        failed ? "failed" : "sent", failed ? 5 : 1, at, failed ? "provider timeout" : null, at, failed ? null : at + 2, at, at + 5);
      totals.outbox += 1;
      const sms = c.market === 0 && hrng.chance(0.5);
      insReceipt.run(`ndr_scale_${pad(i, 7)}`, `${outboxId}:${sms ? "sms" : "email"}`, outboxId, orderId, orderId, type, sms ? "sms" : "email", sms ? "sms-gateway" : "smtp",
        hsha(`${c.id}:${sms ? "sms" : "email"}`), sms ? "01*****" + c.phone.slice(-4) : "c***r@example.test", failed ? "failed" : "delivered", failed ? 5 : 1, at, at + 1,
        failed ? null : at + 1, failed ? null : at + 3, failed ? at + 4 : null, failed ? "provider timeout" : null, at, at + 5);
      totals.receipts += 1;
    }

    // Reviews of delivered lines.
    if (life.delivered && deletedAt === null) {
      priced.lines.forEach((line, k) => {
        if (!hrng.chance(reviewRate) || fulfilledQty[k] === 0) return;
        const variant = linesIn[k].variant;
        const key = `${variant.productId}|${c.id}`;
        if (reviewKeys.has(key)) return;
        reviewKeys.add(key);
        const rating = hrng.weighted([[5, 48], [4, 26], [3, 11], [2, 6], [1, 9]]);
        const status = hrng.weighted([["published", 85], ["pending", 8], ["rejected", 5], ["withdrawn", 2]]);
        const created = Math.min(NOW - 5, deliveredTs + hrng.int(1, 20) * DAY + hrng.int(0, DAY));
        const published = status === "published" ? created + hrng.int(60, 2 * DAY) : null;
        const reply = status === "published" && hrng.chance(0.12);
        const bn = c.bangla && hrng.chance(0.5);
        const body = hrng.chance(0.08) ? null : bn ? hrng.pick(BANGLA_REVIEW_BODIES) : hrng.chance(0.002) ? "Very detailed review. ".repeat(180).trim() : hrng.pick(REVIEW_BODIES);
        const display = (c.name.split(" ")[0] + " " + (c.name.split(" ")[1]?.[0] ?? "")).trim().slice(0, 58) || "Customer";
        insReview.run(`rev_scale_${pad(i, 7)}_${k}`, variant.productId, variant.id, orderId, itemIds[k], `c:${c.id}`, c.id, display, variant.label, rating,
          hrng.chance(0.7) ? hrng.pick(REVIEW_TITLES) : null, body, status, status === "rejected" ? hrng.pick(["spam", "off_topic", "abusive"]) : null,
          published, reply ? "Thank you for your feedback!" : null, reply ? activeStaff[i % activeStaff.length] : null, reply ? published + DAY : null, created, published ?? created);
        totals.reviews += 1;
      });
    }

    if (convOrderRate > 0 && convOrders.length < convTarget && hrng.chance(convOrderRate)) convOrders.push({ orderId, customerId: c.id, ts: Math.min(NOW - 600, ts + hrng.int(3600, 6 * DAY)), customerName: c.name });
    if (giftOrders.length < 6000 && hrng.chance(6000 / ORDERS) && c.market === 0) giftOrders.push({ orderId, customerId: c.id, ts });
  }

  const ORDER_BATCH = 2000;
  const orderStarted = Date.now();
  for (let start = 0; start < ORDERS; start += ORDER_BATCH) {
    tx(() => {
      for (let i = start; i < Math.min(ORDERS, start + ORDER_BATCH); i += 1) seedOrder(i);
    });
    const done = Math.min(ORDERS, start + ORDER_BATCH);
    if ((start / ORDER_BATCH) % 10 === 9 && freeGigabytes(resolvedState) < 1.5) throw new Error("Free disk fell below 1.5 GB; stopping the seed cleanly.");
    if ((start / ORDER_BATCH) % 25 === 24 || done === ORDERS) {
      const rate = done / ((Date.now() - orderStarted) / 1000);
      log(`orders: ${done}/${ORDERS} (${rate.toFixed(0)}/s, eta ${(((ORDERS - done) / rate) / 60).toFixed(1)} min; items ${totals.items}, reviews ${totals.reviews})`);
    }
  }
  Object.assign(hugeCounts, totals);

  // --------------------------------------------------------- final promotions
  // Redemptions need an active promotion, so promotions get their final lifecycle
  // (expired, paused, archived, limits, drafts) only after the orders exist. The
  // revision stays 1, so every allocation keeps pointing at the revision it used.
  tx(() => {
    const finish = db.prepare("UPDATE promotions SET status = ?, starts_at = ?, ends_at = ?, max_redemptions = ?, deleted_at = ?, updated_at = ? WHERE id = ?");
    promos.forEach((promo, k) => {
      let status = "active";
      let startsAt = null;
      let endsAt = null;
      let deletedAt = null;
      let limit = null;
      const roll = hrng.rand();
      if (promo.used === 0) {
        status = roll < 0.3 ? "draft" : roll < 0.5 ? "paused" : roll < 0.7 ? "archived" : "active";
        if (status === "archived" && hrng.chance(0.25)) deletedAt = NOW - 5 * DAY;
      } else {
        status = roll < 0.65 ? "active" : roll < 0.8 ? "paused" : "archived";
      }
      if (status === "active" && hrng.chance(0.35)) { startsAt = NOW - hrng.int(5, 120) * DAY; endsAt = hrng.chance(0.5) ? NOW + hrng.int(60, 200) * DAY : null; }
      if (status === "archived") { startsAt = NOW - hrng.int(200, 700) * DAY; endsAt = startsAt + hrng.int(5, 60) * DAY; }
      if (promo.method === "code" && promo.used > 0 && hrng.chance(0.3)) limit = promo.used + hrng.int(20, 500);
      finish.run(status, startsAt, endsAt, limit, deletedAt, promo.created + 86400, promo.id);
    });
  });
  log(`promotions finalised; redemptions ${totals.redemptions}, allocations ${totals.allocations}`);

  // -------------------------------------------------------------- gift cards
  const insCard = db.prepare(`INSERT INTO gift_cards (id, code_hash, code_ciphertext, code_last4, currency_code, initial_amount_minor, balance_minor, status, expires_at, source, customer_id, recipient_name, recipient_email, message, note, issued_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'BDT', ?, 0, 'active', NULL, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insCardTx = db.prepare(`INSERT INTO gift_card_transactions (id, gift_card_id, kind, amount_minor, balance_after_minor, order_id, idempotency_key, actor_type, actor_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  tx(() => {
    const finishCard = db.prepare("UPDATE gift_cards SET status = ?, expires_at = ? WHERE id = ?");
    for (let k = 0; k < PROFILE.giftCards; k += 1) {
      const id = `gc_scale_${pad(k, 6)}`;
      const code = `GC${hsha(`gift-${SEED}-${k}`).slice(0, 14).toUpperCase()}`;
      const initial = hrng.pick([50000, 100000, 200000, 500000, 1000000]);
      const created = NOW - hrng.int(10, 900) * DAY;
      const customer = hrng.chance(0.5) ? customers[hrng.int(0, Math.min(CUSTOMERS, 5000) - 1)] : null;
      insCard.run(id, hsha(code), `seed:${hsha(`cipher-${k}`).slice(0, 24)}`, code.slice(-4), initial, customer?.id ?? null,
        hrng.chance(0.4) ? hrng.pick(FIRST) : null, null, hrng.chance(0.3) ? "Happy Eid!" : null, hrng.chance(0.2) ? "Corporate gift batch" : null, hrng.pick(activeStaff), created, created);
      insCardTx.run(`gct_scale_${pad(k, 6)}_i`, id, "issue", initial, initial, null, `seed-issue-${k}`, "admin", hrng.pick(activeStaff), null, created);
      let balance = initial;
      const redeems = hrng.weighted([[0, 40], [1, 35], [2, 20], [3, 5]]);
      for (let r = 0; r < redeems && balance > 0 && giftOrders.length; r += 1) {
        const order = giftOrders[hrng.int(0, giftOrders.length - 1)];
        const amount = r === redeems - 1 && hrng.chance(0.4) ? balance : Math.min(balance, hrng.int(10, 40) * 1000);
        balance -= amount;
        insCardTx.run(`gct_scale_${pad(k, 6)}_r${r}`, id, "redeem", -amount, balance, order.orderId, `seed-redeem-${k}-${r}`, "system", null, null, Math.max(created, Math.min(NOW - 1, order.ts + 60)));
      }
      const roll = hrng.rand();
      if (roll < 0.1) finishCard.run("disabled", null, id);
      else if (roll < 0.25) finishCard.run("active", NOW - hrng.int(1, 200) * DAY, id);
      else if (roll < 0.5) finishCard.run("active", NOW + hrng.int(60, 700) * DAY, id);
    }
  });
  hugeCounts.giftCards = PROFILE.giftCards;
  log(`gift cards: ${PROFILE.giftCards}`);

  // ------------------------------------------------------------ conversations
  const insConv = db.prepare(`INSERT INTO conversations (id, subject_type, subject_id, order_id, customer_id, subject, status, assignee_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`);
  const bumpSeq = db.prepare("UPDATE conversations SET last_seq = last_seq + 1 WHERE id = ?");
  const insMessage = db.prepare(`INSERT INTO conversation_messages (id, conversation_id, seq, kind, visibility, author_type, author_customer_id, author_user_id, body, event_kind, event_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const finishConv = db.prepare("UPDATE conversations SET status = ?, customer_read_seq = ?, staff_read_seq = ?, last_message_at = ?, last_author_type = ?, closed_at = ?, updated_at = ?, version = ? WHERE id = ?");
  const storeCount = PROFILE.conversations - convOrders.length;
  const threads = [
    ...convOrders.map((order) => ({ kind: "order", ...order })),
    ...Array.from({ length: Math.max(0, storeCount) }, (_, k) => {
      const c = customers[hrng.int(0, Math.min(CUSTOMERS, 60000) - 1)];
      return { kind: "store", orderId: null, customerId: c.id, customerName: c.name, ts: Math.min(NOW - 600, sampleTime(hrng, clock)) };
    }),
  ];
  const meanMessages = PROFILE.messages / Math.max(1, threads.length);
  let messageTotal = 0;
  const SUBJECTS = ["Where is my order?", "Change delivery address", "Damaged product", "Warranty question", "Return request", "Payment issue", "Product availability"];
  for (let from = 0; from < threads.length; from += 2000) {
    tx(() => {
      threads.slice(from, from + 2000).forEach((thread, offset) => {
        const index = from + offset;
        const id = `cnv_scale_${pad(index, 6)}`;
        const assignee = hrng.chance(0.55) ? hrng.pick(activeStaff) : null;
        insConv.run(id, thread.kind, thread.orderId, thread.orderId, thread.customerId, hrng.chance(0.85) ? hrng.pick(SUBJECTS) : null, assignee, thread.ts, thread.ts);
        const count = index === 3 ? 300 : Math.min(60, 1 + Math.floor(-Math.log(1 - hrng.rand()) * (meanMessages - 1)));
        let at = thread.ts;
        let lastAuthor = "customer";
        for (let seq = 1; seq <= count; seq += 1) {
          bumpSeq.run(id);
          at = Math.min(NOW - 1, at + hrng.int(60, 6 * 3600));
          const fromCustomer = seq === 1 || hrng.chance(0.45);
          const bn = hrng.chance(0.1);
          const event = !fromCustomer && hrng.chance(0.06);
          const internal = !fromCustomer && !event && hrng.chance(0.08);
          const author = fromCustomer ? "customer" : "staff";
          lastAuthor = event ? "system" : author;
          const staffId = assignee ?? hrng.pick(activeStaff);
          if (event) insMessage.run(`msg_scale_${pad(index, 6)}_${seq}`, id, seq, "event", "public", "system", null, null, null, "assigned", JSON.stringify({ assigneeUserId: staffId }), at);
          else insMessage.run(`msg_scale_${pad(index, 6)}_${seq}`, id, seq, "message", internal ? "internal" : "public", author, fromCustomer ? thread.customerId : null, fromCustomer ? null : staffId,
            fromCustomer ? (bn ? hrng.pick(MESSAGE_BANGLA) : hrng.pick(MESSAGE_CUSTOMER)) : internal ? "Checked with the courier hub." : hrng.pick(MESSAGE_STAFF), null, null, at);
          messageTotal += 1;
        }
        const roll = hrng.rand();
        const status = roll < 0.35 ? "open" : roll < 0.5 ? "pending" : "closed";
        const closedAt = status === "closed" ? Math.min(NOW - 1, at + hrng.int(600, 2 * DAY)) : null;
        const staffRead = status === "open" && hrng.chance(0.4) ? Math.max(0, count - hrng.int(1, 3)) : count;
        finishConv.run(status, Math.max(0, count - (hrng.chance(0.3) ? 1 : 0)), staffRead, at, lastAuthor, closedAt, closedAt ?? at, 1 + Math.floor(count / 3), id);
      });
    });
  }
  hugeCounts.conversations = threads.length;
  hugeCounts.messages = messageTotal;
  log(`conversations: ${threads.length} (${messageTotal} messages)`);

  // ------------------------------------------------------------- audit events
  const insAudit = db.prepare(`INSERT INTO agent_audit_events (id, owner_user_id, resource, operation_id, risk, outcome, http_status, duration_ms, request_id, resource_ids_json, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const OPERATIONS = [["orders.list", "read"], ["orders.get", "read"], ["products.list", "read"], ["products.update", "write"], ["orders.refund", "financial"], ["customers.export", "read"], ["settings.update", "security"], ["products.delete", "destructive"], ["inventory.adjust", "write"], ["promotions.create", "write"]];
  for (let from = 0; from < PROFILE.auditEvents; from += 10000) {
    tx(() => {
      for (let k = from; k < Math.min(PROFILE.auditEvents, from + 10000); k += 1) {
        const [operation, risk] = hrng.pick(OPERATIONS);
        const outcome = hrng.weighted([["success", 92], ["denied", 4], ["failed", 4]]);
        insAudit.run(`aae_${hsha(`audit-${k}`).slice(0, 20)}`, hrng.pick(activeStaff), hrng.pick(["dashboard", "dashboard", "storefront"]), operation, risk, outcome,
          outcome === "success" ? 200 : outcome === "denied" ? 403 : 500, hrng.int(8, 900), `req_${hsha(`req-${k}`).slice(0, 16)}`, "[]",
          JSON.stringify({ seeded: true }), Math.min(NOW - 1, sampleTime(hrng, clock)));
      }
    });
  }
  hugeCounts.auditEvents = PROFILE.auditEvents;
  log(`audit events: ${PROFILE.auditEvents}`);
}
// Event triggers (the domain-event outbox): dropped for the seed, recreated after.
function dropEventTriggers() {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'evt\\_%' ESCAPE '\\'").all();
  writeFileSync(droppedFile, rows.map((row) => row.sql).join(TRIGGER_SEPARATOR));
  for (const row of rows) db.exec(`DROP TRIGGER \`${row.name}\``);
  log(`dropped ${rows.length} event-outbox triggers for the seed (saved to ${droppedFile})`);
}
function divRoundLocal(numerator, denominator) {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

const PLACES_BY_CITY = seedDeliveryPlaces();
if (HUGE) {
  seedHuge();
} else {
// ---------------------------------------------------------------- customers + orders
// Order lines snapshot the product's name and the SKU's option label, as checkout does.
const lineLabels = variantLabels();
const variantsByProduct = db.prepare(`SELECT v.id AS id, v.product_id AS product_id, v.price_minor AS price_minor, p.name AS product_name
  FROM product_variants AS v JOIN products AS p ON p.id = v.product_id WHERE v.deleted_at IS NULL`).all()
  .map((row) => ({ ...row, label: lineLabels.get(row.id) ?? null }));
const customerIds = [];
tx(() => {
  for (let index = 0; index < CUSTOMERS; index += 1) {
    const id = `cus_scale_${pad(index, 6)}`;
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const city = pick(CITIES);
    const createdAt = NOW - int(0, 700) * DAY;
    int(1, 200); // the address draws the seed always made (addresses now live in customer_addresses)
    int(1, 30);
    insCustomer.run(id, name, chance(0.5) ? `customer${index}@example.test` : null, `+88017${pad(index, 8)}`, 0, null, "order", createdAt, createdAt, null);
    customerIds.push({ id, name, city, phone: `+88017${pad(index, 8)}` });
  }
});
log(`customers: ${CUSTOMERS}`);

const STATUSES = ["pending", "processing", "confirmed", "shipped", "delivered", "completed", "completed", "completed", "cancelled", "returned"];
const SHIPPED_STATUSES = new Set(["shipped", "delivered", "completed", "returned"]);
let orderItems = 0;
let fulfilledLines = 0;
for (let start = 0; start < ORDERS; start += 5000) {
  tx(() => {
    for (let index = start; index < Math.min(ORDERS, start + 5000); index += 1) {
      const customer = pick(customerIds);
      const status = pick(STATUSES);
      const createdAt = NOW - int(0, 700) * DAY - int(0, DAY);
      const lines = Array.from({ length: int(1, 4) }, () => pick(variantsByProduct));
      const quantities = lines.map(() => int(1, 3));
      const subtotal = lines.reduce((sum, line, lineIndex) => sum + line.price_minor * quantities[lineIndex], 0);
      // The zone's rate (Inside or Outside Dhaka), free on about a third of orders.
      const location = deliveryLocation(PLACES_BY_CITY, customer.city, index);
      const inside = customer.city === "Dhaka";
      const shipping = pick([6000, 12000, 0]) === 0 ? 0 : inside ? 6000 : 12000;
      const total = subtotal + shipping;
      // One order in 40 is a business invoice on net 30 terms (paid later by its due date).
      const netTerms = index % 40 === 7 && status !== "cancelled";
      const paid = !netTerms && (status === "completed" || status === "delivered") ? total : 0;
      const id = `ord_scale_${pad(index, 6)}`;
      // Orders that left the warehouse carry a real shipping fulfilment (so a return can be recorded
      // against them); one in five multi-line shipped orders is only partly fulfilled.
      const shipped = SHIPPED_STATUSES.has(status);
      const fulfilment = !shipped ? "none" : status === "shipped" && lines.length > 1 && chance(0.2) ? "partial" : "complete";
      const address = `House ${int(1, 200)}, Road ${(index % 30) + 1}`;
      const method = chance(0.8) ? (netTerms ? "net_terms" : "cod") : netTerms ? "net_terms" : "sslcommerz";
      const updatedAt = createdAt + int(0, 10) * DAY;
      insOrder.run(id, 100000 + index, customer.name, customer.phone, null, address,
        location.city, location.zone, location.area, location.cityName, location.zoneName, location.areaName,
        inside ? "sm_scale_inside" : "sm_scale_outside", shipping === 0 ? "Free delivery" : inside ? DELIVERY_RATE_NAMES.inside : DELIVERY_RATE_NAMES.outside,
        status, method, paid ? "paid" : "unpaid", fulfilment === "none" ? "pending" : fulfilment, customer.id,
        subtotal, shipping, total, paid, total - paid, netTerms ? 30 : null, netTerms ? createdAt + 30 * DAY : null, createdAt, updatedAt);
      lines.forEach((line, lineIndex) => {
        insOrderItem.run(`oi_scale_${pad(index, 6)}_${lineIndex}`, id, line.product_id, line.id, quantities[lineIndex],
          line.product_name, line.label, line.price_minor, line.price_minor * quantities[lineIndex], line.price_minor * quantities[lineIndex], createdAt);
        orderItems += 1;
      });
      seedUntaxedSnapshot(id, lines.map((_line, lineIndex) => `oi_scale_${pad(index, 6)}_${lineIndex}`), shipping,
        location, createdAt);
      const shippedAt = fulfilment === "none" ? null : createdAt + int(1, 3) * DAY;
      if (method === "cod") {
        seedCodTracking(id, { status, paidMinor: paid, shippedAt, collectedAt: shippedAt === null ? null : shippedAt + DAY,
          collectedBy: "Steadfast", createdAt, updatedAt });
      }
      if (fulfilment !== "none") {
        const fulfillmentId = `ful_scale_${pad(index, 6)}`;
        insShipFulfillment.run(fulfillmentId, id, shippedAt);
        lines.forEach((_line, lineIndex) => {
          if (fulfilment === "partial" && lineIndex > 0) return;
          insShipFulfillmentLine.run(`fln_scale_${pad(index, 6)}_${lineIndex}`, fulfillmentId, id, `oi_scale_${pad(index, 6)}_${lineIndex}`, quantities[lineIndex], shippedAt);
          fulfilledLines += 1;
        });
      }
    }
  });
}
// One order with a long history (ord_scale_000001), so the timeline pages and reads at density:
// eight rounds of a call note, a failed delivery attempt and a staff note, then the shipment.
{
  const insEvent = insert("INSERT INTO order_events (id, order_id, kind, body, data, actor_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)");
  const order = db.prepare("SELECT id, created_at AS at FROM orders WHERE id = 'ord_scale_000001'").get();
  if (order) {
    const NOTES_LONG = ["Called the customer, no answer.", "Customer asked to deliver after 6 pm.", "Rider says the gate was locked; will try again tomorrow.", "Customer confirmed the address by phone: House 12, Road 5."];
    const COD_REASONS = ["not_home", "refused", "no_cash", "wrong_address"];
    const events = [["status_changed", null, { from: "pending", to: "confirmed" }], ["details_edited", null, {}]];
    for (let round = 0; round < 8; round += 1) {
      events.push(["comment", NOTES_LONG[round % NOTES_LONG.length], null]);
      events.push(["cod_failed", null, { reason: COD_REASONS[round % COD_REASONS.length] }]);
      events.push(["comment", `Attempt ${round + 2} booked with the courier.`, null]);
    }
    events.push(["shipment_created", null, { courierName: "Steadfast", quantity: 2, trackingId: "SF-88213490" }]);
    db.prepare("DELETE FROM order_events WHERE order_id = ?").run(order.id);
    tx(() => events.forEach(([kind, body, data], k) => insEvent.run(`oev_scale_long_${pad(k, 3)}`, order.id, kind, body, data ? JSON.stringify(data) : null, Math.min(NOW - 60, order.at + (k + 1) * 4 * 3600))));
    log(`timeline: ${events.length} events on ${order.id}`);
  }
}
db.exec(`UPDATE customers SET total_orders = (SELECT count(*) FROM orders WHERE orders.customer_id = customers.id), last_order_at = (SELECT max(created_at) FROM orders WHERE orders.customer_id = customers.id)`);
// Same-currency money chain (migration 0111): the shop amounts analytics sum
// equal the presentment amounts, as checkout writes them.
db.exec(`UPDATE orders SET shop_currency = currency_code, subtotal_shop_minor = subtotal_amount_minor,
  shipping_shop_minor = shipping_amount_minor, discount_shop_minor = discount_amount_minor,
  tax_shop_minor = tax_amount_minor, total_shop_minor = total_amount_minor`);
log(`orders: ${ORDERS} (items ${orderItems}, fulfilled lines ${fulfilledLines})`);

}

// ---------------------------------------------------------- open-order stock
// Open orders hold their units as checkout reserved them: one ledger-v2
// `reserved` movement per order and SKU (regular pool, generation 1) in the
// same transaction as the SKU's counter edge, and `inventory_action =
// 'reserved'`, so staff item edits release and re-reserve exactly as on a live
// order. A line copies its SKU's inventory tracking, as checkout does. The
// seed drew order lines without checking stock, so a SKU short of the units an
// open order holds is first counted up (an `adjusted` movement at the default
// location) instead of over-reserving.
function reserveOpenOrders() {
  db.exec(`UPDATE order_items SET inventory_tracked = 0
    WHERE inventory_tracked = 1 AND variant_id IN (SELECT id FROM product_variants WHERE track_inventory = 0)`);
  const lines = db.prepare(`SELECT oi.order_id AS orderId, oi.variant_id AS variantId, SUM(oi.quantity) AS quantity, o.created_at AS at
    FROM orders AS o JOIN order_items AS oi ON oi.order_id = o.id
    WHERE o.status IN ('pending', 'processing', 'confirmed') AND o.deleted_at IS NULL AND oi.inventory_tracked = 1
      AND NOT EXISTS (SELECT 1 FROM order_fulfillment_lines AS fl WHERE fl.order_id = o.id)
    GROUP BY oi.order_id, oi.variant_id ORDER BY o.created_at, oi.order_id, oi.variant_id`).all();
  const readSku = db.prepare("SELECT stock, reserved_stock AS reserved, preorder_stock AS preorder, stock_version AS version FROM product_variants WHERE id = ?");
  const insMovement = db.prepare(`INSERT INTO inventory_movements (id, variant_id, order_id, type, quantity, previous_stock, new_stock, notes, created_by,
    ledger_version, pool, reservation_generation, stock_version_before, stock_version_after, stock_delta, previous_reserved_stock, new_reserved_stock,
    reserved_stock_delta, previous_preorder_stock, new_preorder_stock, preorder_stock_delta, created_at, location_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 2, 'regular', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
  const setCounters = db.prepare("UPDATE product_variants SET stock = ?, reserved_stock = ?, stock_version = ? WHERE id = ? AND stock_version = ?");
  const reservedOrders = new Set();
  let counted = 0;
  tx(() => {
    for (const line of lines) {
      let sku = readSku.get(line.variantId);
      const shortfall = line.quantity - (sku.stock - sku.reserved);
      if (shortfall > 0) {
        insMovement.run(`adj_scale_${line.orderId}_${line.variantId}`, line.variantId, null, "adjusted", shortfall, sku.stock, sku.stock + shortfall,
          "Counted in before an open order reserved it", null, sku.version, sku.version + 1, shortfall, sku.reserved, sku.reserved, 0,
          sku.preorder, sku.preorder, line.at - 60, "loc_default");
        setCounters.run(sku.stock + shortfall, sku.reserved, sku.version + 1, line.variantId, sku.version);
        sku = readSku.get(line.variantId);
        counted += 1;
      }
      insMovement.run(`rsv_scale_${line.orderId}_${line.variantId}`, line.variantId, line.orderId, "reserved", line.quantity, sku.stock, sku.stock,
        `Reserved ${line.quantity} units for order ${line.orderId}`, 1, sku.version, sku.version + 1, 0, sku.reserved, sku.reserved + line.quantity,
        line.quantity, sku.preorder, sku.preorder, line.at, null);
      setCounters.run(sku.stock, sku.reserved + line.quantity, sku.version + 1, line.variantId, sku.version);
      reservedOrders.add(line.orderId);
    }
    const markReserved = db.prepare("UPDATE orders SET inventory_action = 'reserved', inventory_pool = 'regular' WHERE id = ?");
    for (const orderId of reservedOrders) markReserved.run(orderId);
  });
  log(`open-order stock: ${lines.length} reservations on ${reservedOrders.size} orders (${counted} SKUs counted up first)`);
}
reserveOpenOrders();

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

if (HUGE) {
  // The nightly sales-stats cron windows on the real clock; the seed's orders end at
  // NOW, so the units sold in the last 30 days of seeded time are filled here (same statement).
  db.exec(`INSERT INTO product_sales_stats (product_id, sold_30d, computed_at)
    SELECT sales_line.product_id, SUM(sales_line.quantity), ${NOW}
    FROM orders AS sales_order INNER JOIN order_items AS sales_line ON sales_line.order_id = sales_order.id
    WHERE sales_order.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed')
      AND sales_order.deleted_at IS NULL AND sales_order.created_at >= ${NOW - 30 * DAY} AND sales_line.quantity > 0
      AND EXISTS (SELECT 1 FROM products WHERE products.id = sales_line.product_id)
    GROUP BY sales_line.product_id`);
  // Customer aggregates come from the trigger-maintained customer_order_stats
  // (the single source), so the stored counters agree with it.
  db.exec(`UPDATE customers SET
      total_orders = (SELECT s.orders_count FROM customer_order_stats AS s WHERE s.customer_id = customers.id),
      last_order_at = (SELECT s.last_order_at FROM customer_order_stats AS s WHERE s.customer_id = customers.id)
    WHERE EXISTS (SELECT 1 FROM customer_order_stats AS s WHERE s.customer_id = customers.id)`);
  log("customer counters aligned with customer_order_stats");
  // Seed-time events are history, not news: empty the outbox, then bring the
  // triggers back so every later write publishes normally.
  db.exec("DELETE FROM event_outbox");
  log(`restored ${restoreTriggers()} event-outbox triggers; event_outbox emptied`);
}

// ------------------------------------------------------------ media objects
// Wrangler's local platform proxy opens the bucket in the on-disk format `wrangler dev --persist-to`
// reads, so the seeded rows' files exist. `--no-media-files` skips it (rows only, files 404).
if (!flag("--no-media-files")) {
  const bucketName = /"bucket_name":\s*"([^"]+)"/.exec(readFileSync(join(root, "apps", "api", "wrangler.local.jsonc"), "utf8"))?.[1];
  if (!bucketName) throw new Error("Could not read the media bucket name from apps/api/wrangler.local.jsonc.");
  const wranglerEntry = createRequire(join(root, "apps", "api", "package.json")).resolve("wrangler");
  const { getPlatformProxy } = await import(pathToFileURL(wranglerEntry).href);
  const objectKeys = db.prepare("SELECT object_key FROM media WHERE status = 'ready'").all().map((row) => row.object_key);
  const configDir = mkdtempSync(join(tmpdir(), "scalius-seed-media-"));
  const configPath = join(configDir, "wrangler.json");
  writeFileSync(configPath, JSON.stringify({ name: "seed-media", compatibility_date: "2025-01-01", r2_buckets: [{ binding: "MEDIA", bucket_name: bucketName }] }));
  const proxy = await getPlatformProxy({ configPath, persist: { path: join(resolvedState, "v3") } });
  try {
    const bucket = proxy.env.MEDIA;
    let written = 0;
    for (let start = 0; start < objectKeys.length; start += 50) {
      await Promise.all(objectKeys.slice(start, start + 50).map(async (key) => {
        if (await bucket.head(key)) return;
        await bucket.put(key, PLACEHOLDER_IMAGE, { httpMetadata: { contentType: "image/webp" } });
        written += 1;
      }));
      if ((start / 50) % 200 === 199) log(`media objects: ${written}/${objectKeys.length}`);
    }
    log(`media objects: ${written} written to bucket ${bucketName}`);
  } finally {
    await proxy.dispose();
    rmSync(configDir, { recursive: true, force: true });
  }
}

// No ANALYZE: a migrated D1 has no sqlite_stat1, so plans here match production.
checkpoint();
const COUNT_TABLES = ["products", "product_variants", "product_media", "media", "product_option_definitions", "product_option_values", "product_variant_option_values", "product_attribute_values", "inventory_levels", "inventory_movements", "categories", "category_closure", "brands", "product_buyer_state", "product_facet_values", "collections", "customers", "customer_addresses", "customer_order_stats", "orders", "order_items", "order_payments", "cod_tracking", "order_fulfillments", "order_fulfillment_lines", "order_returns", "order_return_lines", "order_events", "order_discount_allocations", "promotions", "promotion_codes", "promotion_effects", "promotion_conditions", "promotion_redemptions", "gift_cards", "gift_card_transactions", "product_reviews", "product_review_stats", "conversations", "conversation_messages", "user", "markets", "notification_outbox", "notification_delivery_receipts", "agent_audit_events", "cache_dep", "event_outbox", "product_sales_stats"];
const counts = Object.fromEntries(COUNT_TABLES.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
console.log(JSON.stringify(counts, null, 2));
db.close();
const sizeGb = (statSync(dbPath).size / 1024 ** 3).toFixed(2);
log(`done; database ${sizeGb} GB at ${dbPath}; free disk ${freeGigabytes(resolvedState).toFixed(1)} GB`);
