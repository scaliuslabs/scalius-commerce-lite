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

/**
 * A store kit (`variants[].kit`, a SKU made of other SKUs) as the cart holds
 * it: one line, two kits, each at the kit's own price (৳4,800) and an app's
 * add-on priced once per kit (৳100), never per item. The cart check answers
 * it as the API does: its items are checkout's, never separate lines.
 */
export const GALLERY_KIT = {
  key: "line:v3:prod_7:variant:var_kit_7:p:none",
  variantId: "var_kit_7",
  price: 4800,
  line: { id: "prod_7", slug: "eid-gift-set", name: "Eid gift set", price: 4900, quantity: 2, variantId: "var_kit_7", propertiesHash: "none", options: [{ name: "Set", label: "Saree, panjabi and gift box" }] },
  addOn: { key: "_adjustment", label: "Gift wrap", displayValue: "Gold paper and a card", price: 100, priceMinor: 10_000, appId: "acme.wrap" },
} as const;

/**
 * The customer's cart (GameGhor, private-look.md): two lines of one game,
 * an account that takes the store's app's lifetime protection and a redeem
 * key that does not. The app (`gameghor.protection`) lives here only: its
 * line input, its add-on of ৳350 a unit and its blocks (api.ts). `customer`:
 * the account is not protected yet; `customer-protected`: two accounts, each
 * protected, the summary's add-on row opening to the app's lines.
 */
export const GALLERY_CUSTOMER = {
  appId: "gameghor.protection",
  inputKey: "plan",
  protectionMinor: 35_000,
  title: "GAMEGHOR Protection",
  account: {
    key: "line:v3:prod_gta5:variant:var_gta5_account:p:none", variantId: "var_gta5_account", price: 2222,
    line: { id: "prod_gta5", slug: "gta-v-premium-edition", name: "Grand Theft Auto V: Premium Edition", price: 2222, quantity: 1, variantId: "var_gta5_account", propertiesHash: "none", options: [{ name: "Platform", label: "Rockstar Launcher" }, { name: "Type", label: "Account" }] },
  },
  redeem: {
    key: "line:v3:prod_gta5:variant:var_gta5_key:p:none", variantId: "var_gta5_key", price: 1754,
    line: { id: "prod_gta5", slug: "gta-v-premium-edition", name: "Grand Theft Auto V: Premium Edition", price: 1754, quantity: 1, variantId: "var_gta5_key", propertiesHash: "none", options: [{ name: "Type", label: "Redeem Key" }] },
  },
} as const;

/** The customer's cart as the browser keeps it: protected, the account line holds two units at its price with the add-on. */
export function galleryCustomerCart(protectedAccount: boolean): string {
  const { account, redeem } = GALLERY_CUSTOMER;
  const unit = account.price + (protectedAccount ? GALLERY_CUSTOMER.protectionMinor / 100 : 0);
  return JSON.stringify({ items: {
    [account.key]: { ...account.line, price: unit, quantity: protectedAccount ? 2 : 1 },
    [redeem.key]: redeem.line,
  } });
}
