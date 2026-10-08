/**
 * Carts the audit opens the cart page with. The cart lives in the browser
 * (`cart:v3`), so a page rendered without one shows only the empty state and
 * its lines, totals, delivery picker and checkout form would never be looked
 * at. The harness writes the seed into storage before the page loads.
 */
import { cardProduct, cardProducts, type CardProduct } from "./fixtures";

export type GalleryCartSeed = "one" | "three" | "ten" | "sold-out" | "bangla";

const LINE_COUNT: Record<GalleryCartSeed, number> = { one: 1, three: 3, ten: 10, "sold-out": 2, bangla: 3 };

/** The fixture products the cart check answers "sold out" for (the fixture's own sold-out products). */
export function fixtureProductSoldOut(productId: string): boolean {
  const index = Number(/^prod_(\d+)$/.exec(productId)?.[1]);
  return Number.isInteger(index) && !cardProduct(index).availableForSale;
}

function firstSoldOut(): CardProduct {
  for (let index = 0; ; index += 1) {
    const product = cardProduct(index);
    if (!product.availableForSale) return product;
  }
}

/** The cart store as the browser keeps it; the cart normalises line keys on read. */
export function galleryCartSeed(kind: GalleryCartSeed): { items: Record<string, unknown>; discountCodes: string[] } {
  const products = [...cardProducts(LINE_COUNT[kind], 0, { bangla: kind === "bangla" }), ...(kind === "sold-out" ? [firstSoldOut()] : [])]
    .filter((product, index, all) => all.findIndex((other) => other.id === product.id) === index);
  const items = Object.fromEntries(products.map((product, index) => [
    `line-${index}`,
    {
      id: product.id,
      slug: product.slug,
      name: product.name,
      price: product.discountedPrice,
      quantity: kind === "ten" ? (index % 3) + 1 : 1 + (index === 1 ? 1 : 0),
      image: product.imageUrl ?? undefined,
      variantId: `var_${product.id}`,
      options: product.hasVariants ? [{ name: "Size", label: "M" }] : undefined,
      propertiesHash: "none",
      fulfillmentKind: "physical",
    },
  ]));
  return { items, discountCodes: [] };
}
