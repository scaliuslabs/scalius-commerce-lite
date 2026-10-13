/**
 * The gallery's fixture store (dev and test only; docs/STOREFRONT-QUALITY.md):
 * a believable Bangladeshi fashion and electronics shop with long and short
 * names, Bangla text, missing photos, sale and sold-out products, a 1,000+
 * link menu and 50+ listing facets. Everything is deterministic, so a
 * screenshot changes only when a component changes.
 *
 * The payloads follow the API's public read shapes (lib/api/types.ts,
 * lib/api/storefront.ts); `api.ts` serves them.
 */

export const STORE_NAME = "Nakshi Bazar";
export const BANGLA_STORE_NAME = "নকশি বাজার";

/** Fixture images live on the gallery server; `media/<id>.jpg/<w>.webp` is a rendition URL. */
export interface GalleryMediaShape {
  width: number;
  height: number;
}

const MEDIA_SHAPES: Record<string, GalleryMediaShape> = {
  product: { width: 1600, height: 2000 },
  square: { width: 1600, height: 1600 },
  banner: { width: 2400, height: 920 },
  phone: { width: 1080, height: 1440 },
  wide: { width: 2400, height: 1350 },
  logo: { width: 480, height: 160 },
};

/** The media kind is the id's prefix (`product-12`, `banner-eid`). */
export function mediaShape(id: string): GalleryMediaShape {
  return MEDIA_SHAPES[id.split("-")[0] ?? ""] ?? MEDIA_SHAPES.square!;
}

let mediaOrigin = "http://127.0.0.1:4799";
/** The gallery server's origin (set per render); fixture URLs point at it. */
export function setFixtureOrigin(origin: string): void {
  mediaOrigin = origin;
}
export function fixtureOrigin(): string {
  return mediaOrigin;
}

/** The URL of a fixture image's largest rendition (the API publishes that one). */
export function imageUrl(id: string): string {
  const { width } = mediaShape(id);
  return `${mediaOrigin}/__gallery/media/${id}.jpg/${Math.min(width, 1600)}.webp`;
}

export function mediaAsset(id: string, alt = "") {
  const { width, height } = mediaShape(id);
  return { id, url: imageUrl(id), alt, width, height };
}

// ─── Words ────────────────────────────────────────────────────────────────

export const BANGLA_LONG = "হাতে বোনা ঢাকাই জামদানি শাড়ি, সুতি ও রেশমের মিশ্রণে তৈরি, নকশিকাঁথা ফোঁড়ের পাড় সহ উৎসবের বিশেষ সংস্করণ";
export const BANGLA_SHORT = "জামদানি শাড়ি";
export const LONG_NAME = "Handwoven Dhakai Jamdani Saree in Cotton-Silk Blend with Nakshi Kantha Border, Festive Limited Edition (Bottle Green)";
export const ARABIC_TEXT = "تشكيلة العيد من الساري المنسوج يدويًا";

interface ProductSeed {
  name: string;
  bangla?: string;
  category: string;
  brand: string;
  price: number;
  sale?: number;
  soldOut?: boolean;
  noImage?: boolean;
  images?: 1;
  colors?: Array<[string, string]>;
  sizes?: string[];
  specs?: string[];
  rating?: [number, number];
  sold?: number;
  pack?: string;
}

const FASHION_COLORS: Array<[string, string]> = [["Bottle green", "#1f5f4a"], ["Maroon", "#7a1f2b"], ["Mustard", "#c9971c"], ["Indigo", "#2e3a87"], ["Off white", "#f2ede1"]];

const SEEDS: ProductSeed[] = [
  { name: LONG_NAME, bangla: BANGLA_LONG, category: "sarees", brand: "aarong-weave", price: 18500, sale: 15725, colors: FASHION_COLORS, rating: [4.8, 126], sold: 64 },
  { name: "Cotton Panjabi", category: "panjabi", brand: "deshi-dash", price: 2450, colors: FASHION_COLORS.slice(0, 3), sizes: ["S", "M", "L", "XL", "XXL"], rating: [4.4, 38], sold: 22 },
  { name: "Tee", category: "t-shirts", brand: "fabric-lab", price: 490, sale: 390, sizes: ["M", "L"], sold: 140 },
  { name: "Galaxy A56 5G (8/256 GB)", category: "smartphones", brand: "samsung", price: 52999, sale: 48999, colors: [["Awesome graphite", "#2b2b2e"], ["Light gray", "#d9d9db"], ["Olive", "#6b6b3a"]], specs: ["Display: 6.7 in AMOLED, 120 Hz", "Chipset: Exynos 1580", "Battery: 5000 mAh", "Camera: 50 MP OIS"], rating: [4.6, 212], sold: 98 },
  { name: "Redmi Note 15 Pro", category: "smartphones", brand: "xiaomi", price: 34999, soldOut: true, specs: ["Display: 6.67 in AMOLED", "RAM: 8 GB", "Storage: 256 GB"], rating: [4.2, 54] },
  { name: "ThinkPad E14 Gen 6 Intel Core i5-1335U 16 GB DDR5 512 GB SSD 14 in WUXGA IPS Laptop", category: "laptops", brand: "lenovo", price: 98500, specs: ["Processor: Core i5-1335U", "RAM: 16 GB DDR5", "Storage: 512 GB SSD", "Display: 14 in WUXGA IPS"], rating: [4.7, 19], sold: 12 },
  { name: "Nakshi Kantha Cushion Cover", bangla: "নকশিকাঁথা কুশন কভার", category: "home-decor", brand: "aarong-weave", price: 850, noImage: true, pack: "Set of 2" },
  { name: "Buds 3 Pro Wireless Earbuds with ANC", category: "audio", brand: "samsung", price: 21999, sale: 17999, colors: [["Silver", "#c7c9cc"], ["White", "#f5f5f5"]], specs: ["Noise cancelling: Adaptive ANC", "Battery: 30 h with case"], rating: [4.5, 77], sold: 41 },
  { name: "Leather Loafers", category: "footwear", brand: "apex", price: 4200, sizes: ["40", "41", "42", "43", "44"], colors: [["Tan", "#9a6232"], ["Black", "#1c1c1c"]], rating: [4.1, 9] },
  { name: "Silk Three-Piece (Unstitched)", bangla: "সিল্ক থ্রি-পিস", category: "three-piece", brand: "deshi-dash", price: 6800, sale: 5440, colors: FASHION_COLORS.slice(1, 5), sold: 33 },
  { name: "Smart Watch Fit 4", category: "wearables", brand: "xiaomi", price: 8999, soldOut: true, specs: ["Display: 1.82 in AMOLED", "Battery: 10 days"] },
  { name: "Jute Tote Bag", category: "bags", brand: "fabric-lab", price: 690, noImage: true },
  { name: "Mi 4K TV Box S (2nd Gen)", images: 1, category: "smart-home", brand: "xiaomi", price: 6500, specs: ["Resolution: 4K HDR", "OS: Google TV"], rating: [4.3, 31] },
  { name: "Kids Frock", bangla: "শিশুদের ফ্রক", category: "kids", brand: "apex", price: 1150, sale: 920, sizes: ["2Y", "4Y", "6Y"], colors: FASHION_COLORS.slice(2, 4) },
  { name: "Power Bank 20000 mAh 22.5 W Fast Charging with USB-C PD", category: "accessories", brand: "anker", price: 3200, specs: ["Capacity: 20000 mAh", "Output: 22.5 W"], sold: 210, rating: [4.6, 402] },
  { name: "Gamcha", bangla: "গামছা", category: "home-decor", brand: "aarong-weave", price: 250, pack: "Pack of 3", sold: 15 },
];

const BRANDS = [
  ["aarong-weave", "Aarong Weave"], ["deshi-dash", "Deshi Dash"], ["fabric-lab", "Fabric Lab"], ["samsung", "Samsung"],
  ["xiaomi", "Xiaomi"], ["lenovo", "Lenovo"], ["apex", "Apex"], ["anker", "Anker"],
] as const;

export function fixtureBrands(count = 24) {
  const extra = ["Walton", "Bata", "Yellow", "Ecstasy", "Sailor", "Infinity", "Le Reve", "Kay Kraft", "Rang Bangladesh", "Vivo", "Oppo", "Realme", "Asus", "HP", "Dell", "Baseus"];
  const names: Array<readonly [string, string]> = [...BRANDS, ...extra.map((name) => [name.toLowerCase().replace(/\s+/g, "-"), name] as const)];
  return names.slice(0, count).map(([slug, name], index) => ({
    id: `brd_${slug}`,
    name: index === 9 ? "রং বাংলাদেশ" : name,
    slug,
    canonicalPath: null,
    // Some brands have no logo: the wall shows the name.
    logo: index % 4 === 3 ? null : { mediaId: `logo-${slug}`, url: imageUrl(`logo-${slug}`), alt: `${name} logo`, width: 480, height: 160 },
  }));
}

const CATEGORY_NAMES: Record<string, string> = {
  sarees: "Sarees", panjabi: "Panjabi", "t-shirts": "T-shirts", smartphones: "Smartphones", laptops: "Laptops",
  "home-decor": "Home decor", audio: "Audio", footwear: "Footwear", "three-piece": "Three-piece", wearables: "Wearables",
  bags: "Bags", "smart-home": "Smart home", kids: "Kids", accessories: "Accessories",
};

function seedFor(index: number): ProductSeed {
  return SEEDS[index % SEEDS.length]!;
}

/** A card product (the listing and homepage card projection). */
export function cardProduct(index: number, options: { bangla?: boolean } = {}) {
  const seed = seedFor(index);
  const round = Math.floor(index / SEEDS.length);
  const name = options.bangla && seed.bangla ? seed.bangla : round === 0 ? seed.name : `${seed.name} ${round + 1}`;
  const onSale = seed.sale !== undefined;
  const brand = BRANDS.find(([slug]) => slug === seed.brand);
  return {
    id: `prod_${index}`,
    name,
    slug: fixtureSlug(index),
    description: null,
    price: seed.price,
    discountType: onSale ? ("flat" as const) : null,
    discountPercentage: onSale ? Math.round((1 - seed.sale! / seed.price) * 100) : 0,
    discountAmount: onSale ? seed.price - seed.sale! : 0,
    discountedPrice: seed.sale ?? seed.price,
    priceVaries: Boolean(seed.sizes && seed.sizes.length > 3),
    availableForSale: !seed.soldOut,
    quickAddEligible: !seed.soldOut && !seed.colors && !seed.sizes,
    freeDelivery: seed.price > 20000,
    isActive: true,
    metaTitle: null,
    metaDescription: null,
    categoryId: `cat_${seed.category}`,
    category: { id: `cat_${seed.category}`, name: CATEGORY_NAMES[seed.category] ?? seed.category, slug: seed.category, canonicalPath: null },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    deletedAt: null,
    hasVariants: Boolean(seed.colors || seed.sizes),
    imageUrl: seed.noImage ? null : imageUrl(`product-${index % 24}`),
    imageMediaId: seed.noImage ? null : `product-${index % 24}`,
    imageAlt: seed.noImage ? null : name,
    secondaryImageUrl: seed.noImage || seed.images === 1 ? null : imageUrl(`product-${(index + 7) % 24}`),
    rating: seed.rating ? { average: seed.rating[0], count: seed.rating[1] } : null,
    cardFacts: {
      brand: brand ? { name: brand[1], slug: brand[0] } : null,
      keySpecs: seed.specs ?? [],
      options: [
        ...(seed.colors ? [{ name: "Colour", kind: "color" as const, count: seed.colors.length, swatches: seed.colors.slice(0, 5).map(([label, hex]) => ({ label, hex })) }] : []),
        ...(seed.sizes ? [{ name: "Size", kind: "size" as const, count: seed.sizes.length, swatches: [] }] : []),
      ],
      soldLast30Days: seed.sold ?? null,
      packSize: seed.pack ?? null,
      delivery: seed.price > 20000 ? { free: true as const } : { free: false as const, feeFrom: 60 },
    },
  };
}

export type CardProduct = ReturnType<typeof cardProduct>;

export function cardProducts(count: number, offset = 0, options: { bangla?: boolean } = {}): CardProduct[] {
  return Array.from({ length: count }, (_, index) => cardProduct(index + offset, options));
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

// ─── Categories and the 1,000+ link menu ──────────────────────────────────

const DEPARTMENTS = [
  "Women", "Men", "Kids", "Footwear", "Bags", "Jewellery", "Home decor", "Kitchen", "Beauty",
  "Smartphones", "Laptops", "Audio", "Wearables", "Smart home", "Cameras", "Gaming", "Accessories", "Offers",
];
const GROUPS = ["New in", "Ethnic wear", "Western wear", "Best sellers", "By brand", "By price", "Festive edit"];
const LEAVES = ["Sarees", "Salwar kameez", "Kurti", "Panjabi", "Shirts", "T-shirts", "Jeans", "Under ৳999"];

export interface MenuItem {
  id: string;
  title: string;
  href: string;
  imageUrl?: string;
  subMenu?: MenuItem[];
}

/** The header menu: 18 departments x 7 groups x 8 links (1,152 links). */
export function fixtureMenu(): MenuItem[] {
  return DEPARTMENTS.map((department, d) => ({
    id: `nav-${d}`,
    title: d === 2 ? "শিশুদের পোশাক ও খেলনা" : department,
    href: `/categories/${slugify(department)}`,
    imageUrl: imageUrl(`square-cat-${d}`),
    subMenu: GROUPS.map((group, g) => ({
      id: `nav-${d}-${g}`,
      title: group,
      href: `/categories/${slugify(department)}-${slugify(group)}`,
      subMenu: LEAVES.map((leaf, l) => ({
        id: `nav-${d}-${g}-${l}`,
        title: leaf,
        href: `/categories/${slugify(department)}-${slugify(group)}-${l}`,
      })),
    })),
  }));
}

export function menuLinkCount(items: readonly MenuItem[]): number {
  return items.reduce((total, item) => total + 1 + menuLinkCount(item.subMenu ?? []), 0);
}

/** The published category tree, flat, top levels first (the layout read's `categoryTree`). */
export function fixtureCategoryTree() {
  const nodes: Array<{ id: string; name: string; slug: string; parentId: string | null; canonicalPath: null; imageUrl: string | null }> = [];
  DEPARTMENTS.forEach((department, d) => {
    nodes.push({ id: `cat-${d}`, name: department, slug: slugify(department), parentId: null, canonicalPath: null, imageUrl: imageUrl(`square-cat-${d}`) });
  });
  DEPARTMENTS.forEach((department, d) => {
    GROUPS.forEach((group, g) => {
      nodes.push({ id: `cat-${d}-${g}`, name: group, slug: `${slugify(department)}-${slugify(group)}`, parentId: `cat-${d}`, canonicalPath: null, imageUrl: null });
    });
  });
  return { nodes, truncated: true };
}

/** A category-tiles category (by id `cat-<n>`). */
export function homeCategory(id: string) {
  const index = Number(id.replace(/^cat-/, ""));
  const name = DEPARTMENTS[index % DEPARTMENTS.length] ?? "Category";
  return {
    id,
    name: index === 2 ? "শিশুদের পোশাক" : name,
    slug: slugify(name),
    description: index % 2 === 0 ? `Shop ${name.toLowerCase()} from Bangladeshi makers.` : null,
    // Some categories have no photo: the tile shows its name.
    imageUrl: index % 5 === 4 ? null : imageUrl(`square-cat-${index}`),
    canonicalPath: null,
  };
}

export const FIXTURE_CATEGORY_IDS = Array.from({ length: 12 }, (_, index) => `cat-${index}`);

export function categoryDetail(slug: string) {
  return {
    id: "cat-0",
    name: slug === "sarees" ? "Sarees" : "Women",
    slug,
    description: "<p>Handwoven <strong>jamdani</strong>, muslin and tant sarees from weavers in Narayanganj, Tangail and Rajshahi. Free delivery in Dhaka over ৳3,000.</p>",
    content: null,
    imageUrl: imageUrl("banner-category"),
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    parentId: null,
    depth: 0,
    listingTemplate: null,
    children: GROUPS.map((group, g) => ({ id: `cat-0-${g}`, name: group, slug: `women-${slugify(group)}`, canonicalPath: null, imageUrl: g % 3 === 2 ? null : imageUrl(`square-sub-${g}`) })),
    breadcrumb: [{ id: "cat-0", name: "Women", slug, canonicalPath: null, depth: 0 }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

// ─── Listing facets: 55 of them ───────────────────────────────────────────

export function fixtureFacets() {
  const facets: Array<Record<string, unknown>> = [
    {
      id: "brand", name: "Brand", slug: "brand", kind: "brand", display: "search_list", unit: null, range: null,
      values: fixtureBrands(24).map((brand, index) => ({ value: brand.slug, label: brand.name, count: 120 - index * 4, swatch: null })),
    },
    {
      id: "option.color", name: "Colour", slug: "option.color", kind: "option", display: "swatch", unit: null, range: null,
      values: FASHION_COLORS.concat([["Black", "#111111"], ["Sky blue", "#7ab8e8"], ["Peach", "#f4b89a"]]).map(([label, hex], index) => ({ value: slugify(label), label, count: 40 - index * 3, swatch: hex })),
    },
    {
      id: "option.size", name: "Size", slug: "option.size", kind: "option", display: "checkbox", unit: null, range: null,
      values: ["XS", "S", "M", "L", "XL", "XXL", "3XL"].map((label, index) => ({ value: label.toLowerCase(), label, count: index === 6 ? 0 : 30 - index, swatch: null })),
    },
    { id: "attr_screen", name: "Screen size", slug: "screen-size", kind: "attribute", display: "range", unit: "in", values: [], range: { min: 5.5, max: 17.3 } },
  ];
  const attributes = [
    "Fabric", "Pattern", "Occasion", "Sleeve", "Neckline", "Fit", "Work", "Origin", "Weave", "Border", "Wash care",
    "RAM", "Storage", "Processor", "Chipset", "Battery", "Refresh rate", "Network", "SIM", "Camera", "Operating system",
    "Warranty", "Connectivity", "Driver size", "Water resistance", "Charging", "Panel", "Resolution", "Ports", "Graphics",
    "Weight class", "Material", "Closure", "Heel height", "Strap", "Capacity", "Power", "Voltage", "Colour family", "Age group",
    "Gender", "Season", "Collection", "Style", "Length", "Thread count", "Finish", "Certification", "Seller type", "Delivery",
    "আঞ্চলিক কারুশিল্প",
  ];
  attributes.forEach((name, index) => {
    facets.push({
      id: `attr_${index}`, name, slug: slugify(name) || `attr-${index}`, kind: "attribute", display: "checkbox", unit: null, range: null,
      values: Array.from({ length: 2 + (index % 9) }, (_, value) => ({
        value: `v${value}`,
        label: index % 7 === 0 && value === 0 ? "অত্যন্ত দীর্ঘ মানের লেবেল যা দুই লাইনে ভাঙে" : `${name} ${value + 1}`,
        count: Math.max(0, 50 - value * 6 - index),
        swatch: null,
      })),
    });
  });
  return facets;
}

// ─── Product page ─────────────────────────────────────────────────────────

export type ProductScenario = "fashion" | "electronics" | "sold-out" | "no-image" | "bangla" | "simple" | "one-image";

export const PRODUCT_SCENARIO_SLUGS: Record<ProductScenario, string> = {
  fashion: "jamdani-saree",
  electronics: "galaxy-a56",
  "sold-out": "redmi-note-15-pro",
  "no-image": "kantha-cushion",
  bangla: "bangla-three-piece",
  simple: "power-bank",
  "one-image": "mi-tv-box",
};

const SCENARIO_SEED: Record<ProductScenario, number> = {
  fashion: 0, electronics: 3, "sold-out": 4, "no-image": 6, bangla: 9, simple: 14, "one-image": 12,
};

export function fixtureSlug(index: number): string {
  const scenario = (Object.keys(SCENARIO_SEED) as ProductScenario[]).find((key) => SCENARIO_SEED[key] === index);
  return scenario ? PRODUCT_SCENARIO_SLUGS[scenario] : `${slugify(seedFor(index).name).slice(0, 48)}-${index}`;
}

export function fixtureProductIndexOf(slug: string): number | null {
  const scenario = productScenarioOf(slug);
  if (scenario) return SCENARIO_SEED[scenario];
  const suffix = /-(\d+)$/.exec(slug);
  const index = suffix ? Number(suffix[1]) : -1;
  return Number.isSafeInteger(index) && index >= 0 && fixtureSlug(index) === slug ? index : null;
}

export function productScenarioOf(slug: string): ProductScenario | null {
  return (Object.entries(PRODUCT_SCENARIO_SLUGS).find(([, value]) => value === slug)?.[0] as ProductScenario | undefined) ?? null;
}

const REVIEW_BODIES = [
  "The weave is even tighter than in the photos and the colour is exactly as shown. Delivered to Chattogram in two days.",
  "শাড়ির রং ও বুনন খুব সুন্দর। প্যাকেজিং ভালো ছিল।",
  "Good, but the blouse piece was shorter than I expected.",
];

export function productDetail(scenario: ProductScenario | number, flags: { bangla?: boolean } = {}) {
  const index = typeof scenario === "number" ? scenario : SCENARIO_SEED[scenario];
  const seed = seedFor(index);
  const card = cardProduct(index, { bangla: flags.bangla ?? scenario === "bangla" });
  const colors = seed.colors ?? [];
  const sizes = seed.sizes ?? [];
  const options = [
    ...(colors.length ? [{ id: "color", name: "Colour", position: 0, standardMapping: "color" as const, values: colors.map(([label], position) => ({ id: slugify(label), value: label, position })) }] : []),
    ...(sizes.length ? [{ id: "size", name: "Size", position: 1, standardMapping: "size" as const, values: sizes.map((label, position) => ({ id: slugify(label), value: label, position })) }] : []),
  ];
  const combos: Array<Array<{ axis: (typeof options)[number]; value: { id: string; value: string; position: number } }>> = options.reduce<Array<Array<{ axis: (typeof options)[number]; value: { id: string; value: string; position: number } }>>>(
    (rows, axis) => rows.flatMap((row) => axis.values.map((value) => [...row, { axis, value }])),
    [[]],
  );
  const imageIds = seed.noImage ? [] : [0, 1, 2, 3, 4].slice(0, seed.images ?? 5).map((offset) => `product-${(index + offset * 5) % 24}`);
  const variants = combos.map((combo, position) => ({
    id: combo.length ? `sku_${index}_${combo.map((part) => part.value.id).join("_")}` : `sku_${index}`,
    productId: card.id,
    optionCombinationKey: combo.length ? combo.map((part) => `${part.axis.id}=${part.value.id}`).join("&") : null,
    imageId: combo.length && position === 1 && imageIds[1] ? `pm_${imageIds[1]}` : null,
    imageMediaId: null,
    imageUrl: combo.length && position === 1 && imageIds[1] ? imageUrl(imageIds[1]) : card.imageUrl,
    selectedOptions: combo.map((part) => ({
      optionDefinitionId: part.axis.id, optionValueId: part.value.id, name: part.axis.name, value: part.value.value,
      position: part.axis.position, valuePosition: part.value.position, standardMapping: part.axis.standardMapping,
    })),
    weight: null,
    sku: `NB-${index}-${position}`,
    price: seed.price,
    stock: seed.soldOut ? 0 : 5,
    reservedStock: 0,
    availabilityBand: seed.soldOut ? "out_of_stock" : position % 5 === 4 ? "low_stock" : "in_stock",
    isDefault: combo.length === 0,
    trackInventory: true,
    lowStockThreshold: 2,
    barcode: null,
    barcodeType: null,
    discountType: card.discountType,
    discountPercentage: card.discountPercentage,
    discountAmount: card.discountAmount,
    fulfillmentKind: "physical",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
  }));
  const attributes = (seed.specs ?? ["Fabric: Cotton-silk", "Weave: Jamdani", "Length: 5.5 m", "Origin: Narayanganj"]).map((line) => {
    const [name, value] = line.split(": ");
    return { name: name!, value: value ?? "", slug: slugify(name!), group: seed.specs ? "Key specifications" : "Details", unit: null, keySpec: true };
  });
  const product = {
    ...card,
    description: flags.bangla ?? scenario === "bangla"
      ? `<p>${BANGLA_LONG}।</p><p>প্রতিটি পিস হাতে তৈরি, তাই রঙে সামান্য পার্থক্য থাকতে পারে।</p>`
      : "<p>Woven on a pit loom over three weeks. Each piece is unique, so small variations in the motif are part of the craft.</p><ul><li>Dry clean only</li><li>Blouse piece included</li></ul>",
    hasVariants: options.length > 0,
    options,
    features: ["Made in Bangladesh", "Cash on delivery across 64 districts", "7-day easy return"],
    attributes,
    brand: card.cardFacts.brand ? { id: `brd_${card.cardFacts.brand.slug}`, name: card.cardFacts.brand.name, slug: card.cardFacts.brand.slug, canonicalPath: null } : null,
    noIndex: false,
    productCondition: "new",
    pageTemplate: null,
    warranty: seed.specs ? { name: "Official warranty", provider: "brand", duration: { value: 1, unit: "years" }, replacementDays: 7, terms: "Covers manufacturing defects. Physical and liquid damage are not covered." } : null,
    emi: seed.price > 20000 ? { provider: "City Bank", months: 12, monthly: Math.round(seed.price / 12), monthlyMinor: Math.round(seed.price / 12) * 100 } : null,
    bundles: index === SCENARIO_SEED.simple ? [{ quantity: 2, discountType: "percentage", discountPercentage: 10, price: null, label: "Buy 2, save 10%", isActive: true }] : [],
    offers: [],
    customization: null,
    contentBlocks: [],
    contentBlockMedia: [],
    customFields: [],
    reviews: seed.rating
      ? {
          summary: { average: seed.rating[0], count: seed.rating[1], histogram: [5, 4, 3, 2, 1].map((rating) => ({ rating, count: rating === 5 ? Math.round(seed.rating![1] * 0.7) : rating === 4 ? Math.round(seed.rating![1] * 0.2) : 2 })) },
          items: REVIEW_BODIES.map((body, review) => ({
            id: `review_${review}`, rating: 5 - review, title: review === 0 ? "Exactly as pictured" : null, body,
            authorName: ["Farhana R.", "তানভীর আহমেদ", "S. Karim"][review]!, variantLabel: colors[0]?.[0] ?? null,
            verifiedPurchase: true as const, publishedAt: `2026-09-${10 + review}T08:00:00.000Z`, editedAt: null,
            reply: review === 2 ? { body: "Thank you, we have added the blouse length to the description.", repliedAt: "2026-09-14T08:00:00.000Z" } : null,
          })),
          nextCursor: "next",
        }
      : null,
  };
  return {
    product,
    category: { ...categoryDetail(seed.category), name: CATEGORY_NAMES[seed.category] ?? "Category", slug: seed.category },
    media: imageIds.map((id, sortOrder) => ({
      id: `pm_${id}`, mediaId: id, kind: "image", url: imageUrl(id), posterMediaId: null, posterUrl: null,
      altText: `${card.name}, photo ${sortOrder + 1}`, caption: null, ...mediaShape(id), durationMs: null,
      isPrimary: sortOrder === 0, sortOrder, status: "ready",
    })),
    variants,
    recommendations: { reason: "also_bought", products: cardProducts(8, index + 1, { bangla: flags.bangla ?? scenario === "bangla" }) },
  };
}

// ─── Collections ──────────────────────────────────────────────────────────

export function fixtureCollection(id: string, presentation: "grid" | "carousel" = "grid") {
  const names: Record<string, string> = { "col-eid": "Eid edit", "col-new": "New arrivals", "col-tech": "Tech under ৳10,000", "col-bangla": "পূজার কালেকশন" };
  const products = cardProducts(12, id.length);
  return {
    id,
    name: names[id] ?? "Best sellers",
    presentation,
    config: { maxProducts: 12, title: "", subtitle: id === "col-eid" ? "Festive picks from our weavers" : "" },
    sortOrder: 0,
    isActive: true,
    canonicalPath: null,
    noIndex: false,
    listingTemplate: null,
    description: "Handpicked for the season.",
    content: null,
    metaTitle: null,
    metaDescription: null,
    categories: [{ id: "cat_sarees", name: "Sarees", slug: "sarees", canonicalPath: null }],
    products,
    featuredProduct: null,
    pagination: { page: 1, limit: 12, total: 12, totalPages: 1 },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
  };
}

export const FIXTURE_COLLECTION_IDS = ["col-eid", "col-new", "col-tech", "col-bangla"];

// ─── Store identity, menus and policies ───────────────────────────────────

export function fixtureFooterMenus() {
  return [
    { id: "fm-shop", title: "Shop", links: ["Women", "Men", "Kids", "Smartphones", "Laptops", "Offers"].map((title) => ({ id: `fm-${slugify(title)}`, title, href: `/categories/${slugify(title)}` })) },
    { id: "fm-help", title: "Customer care", links: [["Track your order", "/track-order"], ["Returns and refunds", "/pages/returns"], ["Delivery information", "/pages/delivery"], ["গ্রাহক সেবা", "/pages/help"]].map(([title, href]) => ({ id: `fm-${slugify(title!)}`, title: title!, href: href! })) },
    { id: "fm-about", title: "About us", links: [["Our story", "/pages/about"], ["Stores", "/pages/stores"], ["Careers", "/pages/careers"]].map(([title, href]) => ({ id: `fm-${slugify(title!)}`, title: title!, href: href! })) },
  ];
}

export function fixtureBusiness() {
  return {
    companyName: STORE_NAME,
    legalName: "Nakshi Bazar Limited",
    phone: "+8801711000000",
    email: "help@nakshibazar.test",
    address: { line1: "House 12, Road 7, Dhanmondi", city: "Dhaka", postalCode: "1205", country: "BD" },
    socialLinks: [
      { id: "facebook", label: "Facebook", url: "https://facebook.com/nakshibazar" },
      { id: "instagram", label: "Instagram", url: "https://instagram.com/nakshibazar" },
      { id: "youtube", label: "YouTube", url: "https://youtube.com/@nakshibazar" },
    ],
  };
}

export const FIXTURE_POLICIES = [
  { kind: "refund", title: "Refund policy", path: "/pages/refund-policy" },
  { kind: "shipping", title: "Shipping policy", path: "/pages/shipping-policy" },
  { kind: "privacy", title: "Privacy policy", path: "/pages/privacy-policy" },
  { kind: "terms", title: "Terms of service", path: "/pages/terms" },
] as const;

export function fixtureShippingMethods() {
  return [
    { id: "ship_dhaka", name: "Inside Dhaka", fee: 60, description: "1-2 days", isActive: true, sortOrder: 0 },
    { id: "ship_outside", name: "Outside Dhaka", fee: 120, description: "2-4 days", isActive: true, sortOrder: 1 },
  ];
}

export function fixturePage(slug: string, bangla = false) {
  return {
    id: `page_${slug}`,
    contentType: "page",
    title: bangla ? "ফেরত ও রিফান্ড নীতি" : "Returns and refunds",
    slug,
    content: bangla
      ? "<h2>ফেরতের শর্ত</h2><p>পণ্য হাতে পাওয়ার ৭ দিনের মধ্যে ফেরত দিতে পারবেন। ট্যাগ ও প্যাকেজিং অক্ষত থাকতে হবে।</p><ul><li>শাড়ি ও থ্রি-পিস</li><li>ইলেকট্রনিক্স (সিল খোলা না থাকলে)</li></ul>"
      : "<h2>How returns work</h2><p>You can return most items within 7 days of delivery. Keep the tags and the original packaging.</p><h3>Electronics</h3><p>Phones and laptops are returnable only while the seal is unbroken. Faulty devices are covered by the brand warranty.</p><table><thead><tr><th>Item</th><th>Window</th></tr></thead><tbody><tr><td>Fashion</td><td>7 days</td></tr><tr><td>Electronics</td><td>3 days, sealed</td></tr></tbody></table>",
    excerpt: null,
    author: null,
    tags: [],
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    isPublished: true,
    hideHeader: false,
    hideFooter: false,
    hideTitle: false,
    featuredImage: null,
    publishedAt: 1_756_684_800,
    sortOrder: 0,
    createdAt: 1_756_684_800,
    deletedAt: null,
  };
}
