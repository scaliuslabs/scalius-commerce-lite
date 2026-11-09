// A line of the order form, priced today: what the product picker adds and
// what a stored source (an abandoned checkout's "Create order") puts back.
// Both go through `orderLineFor`, so a line is never staged at a stale or
// zero price; the server quote stays the source of the saved total.
import type { QueryClient } from "@tanstack/react-query";
import { productQueryOptions } from "@/lib/api-query-options/products";
import { checkLineProperties, customizationFromView, type CustomizationView, type LinePropertiesCheck } from "./order-line-properties";
import { trackedAvailableStock } from "./manual-order-stock";
import { discountedUnitPrice, orderItemVariantLabel } from "./order-item-presentation";
import type { OrderItem, Product } from "./types";

type ProductVariant = Product["variants"][number];
type RawProductVariant = Omit<ProductVariant, "weight"> & {
  weight: number | string | null;
  deletedAt?: unknown;
};

function normalizeVariant(variant: RawProductVariant): ProductVariant {
  return {
    id: variant.id,
    optionCombinationKey: variant.optionCombinationKey,
    selectedOptions: variant.selectedOptions ?? [],
    weight:
      typeof variant.weight === "string"
        ? parseFloat(variant.weight) || null
        : (variant.weight ?? null),
    sku: variant.sku || "",
    price: variant.price ?? 0,
    stock: variant.stock ?? 0,
    reservedStock: variant.reservedStock ?? 0,
    isDefault: variant.isDefault ?? false,
    trackInventory: variant.trackInventory ?? true,
    discountType: variant.discountType ?? null,
    discountPercentage: variant.discountPercentage ?? null,
    discountAmount: variant.discountAmount ?? null,
    fulfillmentKind: variant.fulfillmentKind ?? "physical",
  };
}

/** A product's live SKUs from a product or variants read (deleted ones left out). */
export function normalizeVariants(result: unknown): ProductVariant[] {
  const variants = (result as { variants?: RawProductVariant[] } | null)?.variants;
  if (!Array.isArray(variants)) return [];
  return variants.filter((variant) => !variant.deletedAt).map(normalizeVariant);
}

/** A product read: its SKUs plus the buyer inputs it asks for. */
export function normalizeProductRead(result: unknown): { variants: ProductVariant[]; customization: Product["customization"] } {
  const view = (result as { customizationSchema?: CustomizationView | null } | null)?.customizationSchema;
  return { variants: normalizeVariants(result), customization: customizationFromView(view) };
}

/**
 * The line for this SKU at today's price: the product/variant sale applies to
 * the base, the inputs' surcharges are added whole (Wave A §3.3).
 */
export function orderLineFor(
  product: Product,
  variant: ProductVariant,
  quantity: number,
  options: { isEdit: boolean; minorFactor: number; inputs?: Extract<LinePropertiesCheck, { ok: true }> | null },
): OrderItem {
  const { inputs } = options;
  return {
    productId: product.id,
    variantId: variant.id,
    quantity,
    price: discountedUnitPrice(product, variant) + (inputs ? inputs.surchargeMinor / options.minorFactor : 0),
    name: product.name,
    variantLabel: orderItemVariantLabel(variant),
    available: options.isEdit ? null : trackedAvailableStock(variant),
    fulfillmentKind: variant.fulfillmentKind ?? "physical",
    ...(inputs && inputs.properties.length > 0
      ? { properties: inputs.properties, propertiesDisplay: inputs.resolved }
      : {}),
  };
}

/** A line kept somewhere else (an abandoned checkout): the SKU, how many, and the buyer inputs it had. */
export interface StoredOrderLine {
  productId: string;
  /** Null for a line saved without its SKU: it can't come back, and is named so. */
  variantId: string | null;
  quantity: number;
  /** For saying which line could not come back. */
  name?: string;
  /** What the buyer last saw for one unit, in the store's currency; absent when unknown. */
  price?: number | null;
  properties?: ReadonlyArray<{ key: string; value: string }>;
}

export interface RestoredOrderLines {
  lines: OrderItem[];
  /** Lines whose product, SKU or inputs are no longer sold as they were. */
  missing: string[];
  /** Lines whose price is not the one the buyer last saw: their name and today's unit price. */
  repriced: Array<{ name: string; price: number }>;
}

/**
 * Puts stored lines back on a new order at today's price, read from each
 * product (one read per product), exactly as the picker would add them.
 * Never a line at a zero or stale price, never a silent drop: a line that
 * can't come back is named in `missing`.
 */
/**
 * A stored line's variant in words ("M / Black"), read from its product as
 * the order form restores it: what an abandoned checkout lists when its line
 * kept no option labels. Null when the product or the variant is gone, or a
 * simple product's one SKU (its name says it all).
 */
export function storedLineVariantLabel(productRead: unknown, variantId: string | null | undefined): string | null {
  if (!productRead || !variantId) return null;
  const variant = normalizeProductRead(productRead).variants.find((candidate) => candidate.id === variantId);
  const label = variant ? orderItemVariantLabel(variant) : "";
  return label && label !== "—" ? label : null;
}

export async function restoreOrderLines(
  queryClient: QueryClient,
  stored: readonly StoredOrderLine[],
  minorFactor: number,
): Promise<RestoredOrderLines> {
  const productIds = [...new Set(stored.map((line) => line.productId))];
  const reads = new Map(await Promise.all(productIds.map(async (id) => {
    const read = await queryClient.fetchQuery(productQueryOptions(id)).catch(() => null);
    return [id, read] as const;
  })));
  const result: RestoredOrderLines = { lines: [], missing: [], repriced: [] };
  for (const line of stored) {
    const read = reads.get(line.productId) as (Product & { deletedAt?: unknown; isActive?: boolean }) | null | undefined;
    const { variants, customization } = normalizeProductRead(read);
    const variant = variants.find((candidate) => candidate.id === line.variantId);
    const inputs = read ? checkLineProperties(customization ?? null, Object.fromEntries((line.properties ?? []).map(({ key, value }) => [key, value]))) : null;
    if (!read || read.deletedAt || !variant || !inputs?.ok) {
      result.missing.push(line.name ?? read?.name ?? line.productId);
      continue;
    }
    const product: Product = { ...read, customization, variants };
    const restored = orderLineFor(product, variant, line.quantity, { isEdit: false, minorFactor, inputs });
    if (typeof line.price === "number" && Math.abs(line.price - restored.price) > 1e-6) {
      result.repriced.push({ name: restored.variantLabel ? `${product.name} (${restored.variantLabel})` : product.name, price: restored.price });
    }
    result.lines.push(restored);
  }
  return result;
}
