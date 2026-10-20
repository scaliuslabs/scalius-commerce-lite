// The demo store as an ordered list of steps, each one platform call that
// creates one thing, and the request each step sends. Pure: the runner
// (run.ts) executes the steps, records what each created in the app's
// Objects, and removes exactly those records' resources again.

import type { DemoPack, DemoProduct } from "../../demo-pack";

export type StepKind = "media" | "category" | "brand" | "product" | "fields" | "collection";

export interface Step {
  /** The record id of what the step creates (`category:iphone`), stable across runs. */
  id: string;
  kind: StepKind;
  /** The pack key it comes from. */
  key: string;
  /** Media: the source address and alt text. */
  url?: string;
  alt?: string;
}

/** What one created resource left in the app's Objects: enough to link to it and to remove it. */
export interface DemoRecord extends Record<string, unknown> {
  kind: StepKind;
  key: string;
  resource_id: string;
  /** The revision (or version) the create answered: removal sends it, so a changed item is kept. */
  revision: number;
  url: string | null;
  filename: string | null;
  size: number | null;
  created_at: string | null;
  /** The category tree depth (removal trashes children first). */
  depth: number;
}

export const mediaStepId = (owner: string, index = 0) => `media:${owner}:${index}`;

/** Every step of the pack, in dependency order: media before what shows it, parents before children. */
export function importPlan(pack: DemoPack): Step[] {
  const steps: Step[] = [];
  const media = (owner: string, url: string, alt: string, index = 0) => steps.push({ id: mediaStepId(owner, index), kind: "media", key: owner, url, alt });
  for (const category of pack.categories) if (category.image) media(`category-${category.key}`, category.image, category.name);
  for (const category of byDepth(pack)) steps.push({ id: `category:${category.key}`, kind: "category", key: category.key });
  for (const brand of pack.brands) steps.push({ id: `brand:${brand.key}`, kind: "brand", key: brand.key });
  for (const product of pack.products) {
    product.images.forEach((url, index) => media(`product-${product.key}`, url, product.name, index));
    steps.push({ id: `product:${product.key}`, kind: "product", key: product.key });
    if (product.specs || product.features || product.code) steps.push({ id: `fields:${product.key}`, kind: "fields", key: product.key });
  }
  for (const collection of pack.collections) steps.push({ id: `collection:${collection.key}`, kind: "collection", key: collection.key });
  for (const banner of pack.banners) media(`banner-${banner.key}`, banner.url, banner.alt);
  return steps;
}

/** The pack's categories, parents first (a parent always precedes its children). */
export function byDepth(pack: DemoPack): Array<DemoPack["categories"][number] & { depth: number }> {
  const parents = new Map(pack.categories.map((category) => [category.key, category.parent]));
  const depth = (key: string, seen = 0): number => {
    const parent = parents.get(key);
    return parent && seen < 4 ? 1 + depth(parent, seen + 1) : 0;
  };
  return pack.categories.map((category) => ({ ...category, depth: depth(category.key) })).sort((a, b) => a.depth - b.depth);
}

/** The order removal runs in: what references others first, then children before parents, media last. */
export function removalOrder(records: Array<{ id: string; data: DemoRecord }>): Array<{ id: string; data: DemoRecord }> {
  const rank: Record<StepKind, number> = { fields: 0, collection: 1, product: 2, brand: 3, category: 4, media: 5 };
  return [...records].sort((a, b) => rank[a.data.kind] - rank[b.data.kind] || (a.data.kind === "category" ? b.data.depth - a.data.depth : 0) || a.id.localeCompare(b.id));
}

/** Variants of an optioned product: every combination of its (at most two) axes. */
export function optionMatrix(product: DemoProduct, stock: number) {
  const options = (product.options ?? []).slice(0, 2).map((option, axis) => ({
    id: `draft_option_${axis}`,
    name: option.name,
    standardMapping: option.mapping,
    values: option.values.map((value, index) => ({ id: `draft_value_${axis}_${index}`, value })),
  }));
  const combos = options.reduce<string[][]>((rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value.id])), [[]]);
  const discount = product.was && product.was > product.price ? product.was - product.price : 0;
  const variants = combos.map((ids, index) => ({
    id: `draft_variant_${index}`,
    selectedOptionValueIds: ids,
    imageId: null,
    sku: `${product.code ?? product.key.toUpperCase()}-${index + 1}`.slice(0, 64),
    price: product.was ?? product.price,
    stock,
    trackInventory: true,
    weight: null,
    barcode: null,
    barcodeType: null,
    discountType: "flat",
    discountPercentage: 0,
    discountAmount: discount,
  }));
  return { options, variants };
}

/** A short plain description from the product's facts, for the demo (the pack holds no long copy). */
export function description(product: DemoProduct): string {
  const parts = [`<p>${escape(product.name)} from the Volt Gadgets demo store.</p>`];
  if (product.features?.length) parts.push(`<ul>${product.features.map((feature) => `<li>${escape(feature)}</li>`).join("")}</ul>`);
  return parts.join("");
}

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
}
