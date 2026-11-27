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
 * The reference cart (a game store): two lines of one game,
 * an account that takes the store's app's lifetime protection and a redeem
 * key that does not. The app (`arcade.protection`) lives here only: its
 * line input, its add-on of ৳350 a unit and its blocks (api.ts). `customer`:
 * the account is not protected yet; `customer-protected`: two accounts, each
 * protected, the summary's add-on row opening to the app's lines.
 */
export const GALLERY_CUSTOMER = {
  appId: "arcade.protection",
  inputKey: "plan",
  protectionMinor: 35_000,
  title: "Arcade Protection",
  account: {
    key: "line:v3:prod_gta5:variant:var_gta5_account:p:none", variantId: "var_gta5_account", price: 2222,
    line: { id: "prod_gta5", slug: "gta-v-premium-edition", name: "Grand Theft Auto V: Premium Edition", price: 2222, quantity: 1, variantId: "var_gta5_account", propertiesHash: "none", options: [{ name: "Edition", label: "Enhanced Edition" }, { name: "Platform", label: "Rockstar Launcher" }, { name: "Format", label: "Account" }, { name: "Region", label: "Global" }] },
  },
  redeem: {
    key: "line:v3:prod_gta5:variant:var_gta5_key:p:none", variantId: "var_gta5_key", price: 1754,
    line: { id: "prod_gta5", slug: "gta-v-premium-edition", name: "Grand Theft Auto V: Premium Edition", price: 1754, quantity: 1, variantId: "var_gta5_key", propertiesHash: "none", options: [{ name: "Type", label: "Redeem Key" }] },
  },
} as const;

/** The protected account line's inputs hash (its plan answered `lifetime`), as the cart store computes it (api.test.ts holds it to that). */
export const CUSTOMER_PROTECTED_HASH = "d71752b2a6a3b969";
export const GALLERY_CUSTOMER_PROTECTED_KEY = `line:v3:prod_gta5:variant:var_gta5_account:p:${CUSTOMER_PROTECTED_HASH}`;

/** More of the reference store's games, each with its four options as the store sells them (taller lines than a plain product's). */
const CUSTOMER_GAMES = [
  { id: "prod_elden", name: "Elden Ring", price: 4679, options: ["Standard Edition", "Steam"] },
  { id: "prod_rdr2", name: "Red Dead Redemption 2", price: 3150, options: ["Ultimate Edition", "Rockstar Launcher"] },
  { id: "prod_cyber", name: "Cyberpunk 2077", price: 2890, options: ["Ultimate Edition", "Steam"] },
  { id: "prod_forza", name: "Forza Horizon 5", price: 3499, options: ["Premium Edition", "Xbox"] },
].map(({ id, name, price, options: [edition, platform] }) => ({
  key: `line:v3:${id}:variant:var_${id}:p:none`,
  line: { id, slug: id.replace("prod_", ""), name, price, quantity: 1, variantId: `var_${id}`, propertiesHash: "none", options: [{ name: "Edition", label: edition }, { name: "Platform", label: platform }, { name: "Format", label: "Account" }, { name: "Region", label: "Global" }] },
}));

/**
 * The customer's cart as the browser keeps it: protected, the account line holds two units at its price with the
 * add-on. `games`: that many more of the store's games after it, instead of the redeem key (five lines in all with four).
 */
export function galleryCustomerCart(protectedAccount: boolean, games = 0): string {
  const { account, redeem } = GALLERY_CUSTOMER;
  const unit = account.price + (protectedAccount ? GALLERY_CUSTOMER.protectionMinor / 100 : 0);
  // With the games, the account line as a store keeps it once protected: the app's answer and its add-on on the line
  // (its "Add-on" row and Edit, as tall as a real line).
  const kept = games > 0 && protectedAccount ? {
    propertiesHash: CUSTOMER_PROTECTED_HASH,
    properties: [{ key: `${GALLERY_CUSTOMER.appId}.${GALLERY_CUSTOMER.inputKey}`, value: "lifetime", label: GALLERY_CUSTOMER.title, displayValue: GALLERY_CUSTOMER.title, priceMinor: 0, appDrawnChoice: true }],
    adjustments: [{ key: "_adjustment", label: GALLERY_CUSTOMER.title, displayValue: "", priceMinor: GALLERY_CUSTOMER.protectionMinor, appId: GALLERY_CUSTOMER.appId }],
  } : {};
  return JSON.stringify({ items: {
    [games > 0 && protectedAccount ? GALLERY_CUSTOMER_PROTECTED_KEY : account.key]: { ...account.line, ...kept, price: unit, quantity: protectedAccount ? 2 : 1 },
    ...(games > 0 ? Object.fromEntries(CUSTOMER_GAMES.slice(0, games).map((game) => [game.key, game.line])) : { [redeem.key]: redeem.line }),
  } });
}
