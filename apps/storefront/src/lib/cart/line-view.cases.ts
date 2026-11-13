/**
 * The table every cart line renderer is tested against: the cart page's
 * (`cartLineHtml`, line-html.test.ts) and the drawer's (CartFlyout,
 * CartFlyout.lines.test.tsx), through `cartLineView`
 * (line-view.test.ts). A row says what a buyer sees on one line; both
 * surfaces must show it, read back through the same data hooks
 * (`shownCartLine`). Test support only: nothing in a page imports it.
 */
import { formatMoney } from "@/lib/currency";
import type { VariantCartItem } from "@/store/cart";
import type { CartLineDiscount, CartLineFulfilmentNote } from "./line-view";

export interface CartLineShown {
  name: string;
  options: string[];
  purchaseOptions: string[];
  inputs: string[];
  components: string[];
  edit: boolean;
  fulfilment: CartLineFulfilmentNote | null;
  quantity: string;
  /** The line's amount as drawn. */
  amount: string;
  /** The struck amount of a free line. */
  compareAt: string | null;
  free: boolean;
  /** One unit's price (the surface's own "each" follows it). */
  unitPrice: string | null;
}

export interface CartLineCase {
  label: string;
  key: string;
  item: VariantCartItem;
  /** The line's share of the store's discounts, as a quote or preview priced it. */
  discount?: CartLineDiscount;
  /** Every other line of the cart (the fulfilment note reads the whole cart). */
  others?: VariantCartItem[];
  shows: CartLineShown;
}

const shirt: VariantCartItem = { id: "prod_shirt", slug: "shirt", name: "Linen shirt", price: 150, quantity: 1, variantId: "sku_shirt" };
const shown = (overrides: Partial<CartLineShown>): CartLineShown => ({
  name: "Linen shirt",
  options: [],
  purchaseOptions: [],
  inputs: [],
  components: [],
  edit: false,
  fulfilment: null,
  quantity: "1",
  amount: formatMoney(150),
  compareAt: null,
  free: false,
  unitPrice: null,
  ...overrides,
});
const physical: VariantCartItem = { id: "prod_lamp", slug: "lamp", name: "Lamp", price: 900, quantity: 1, variantId: "sku_lamp", fulfillmentKind: "physical" };

export const CART_LINE_CASES: CartLineCase[] = [
  { label: "a plain line", key: "k1", item: shirt, shows: shown({}) },
  {
    label: "a line of several, with its unit price",
    key: "k2",
    item: { ...shirt, quantity: 3 },
    shows: shown({ quantity: "3", amount: formatMoney(450), unitPrice: formatMoney(150) }),
  },
  {
    label: "the free line of a buy-one-get-one, struck then zero",
    key: "k3",
    item: shirt,
    discount: { discountMinor: 15_000, quantity: 1, decimalPlaces: 2 },
    shows: shown({ amount: formatMoney(0), compareAt: formatMoney(150), free: true }),
  },
  {
    label: "a line its discount pays only in part, at its full amount",
    key: "k4",
    item: shirt,
    discount: { discountMinor: 5_000, quantity: 1, decimalPlaces: 2 },
    shows: shown({}),
  },
  {
    label: "a line whose free share was priced for another quantity",
    key: "k5",
    item: { ...shirt, quantity: 2 },
    discount: { discountMinor: 15_000, quantity: 1, decimalPlaces: 2 },
    shows: shown({ quantity: "2", amount: formatMoney(300), unitPrice: formatMoney(150) }),
  },
  {
    label: "a line with options and an app's way to buy it",
    key: "k6",
    item: { ...shirt, options: [{ name: "Size", label: "L" }, { name: "Colour", label: "Sand" }], purchaseOptions: [{ id: "acme.subs.monthly", title: "Subscribe monthly" }] },
    shows: shown({ options: ["Size: L", "Colour: Sand"], purchaseOptions: ["Subscribe monthly"] }),
  },
  {
    label: "a line with the buyer's input and an app's line input, editable on the product page",
    key: "k7",
    item: {
      ...shirt,
      price: 350,
      properties: [
        { key: "engraving", value: "Ana", label: "Engraving", displayValue: "Ana", priceMinor: 20_000 },
        { key: "acme.protect:plan", value: "2y", label: "Protection", displayValue: "2 years", priceMinor: 0 },
      ],
    },
    shows: shown({ amount: formatMoney(350), inputs: [`Engraving: Ana (+${formatMoney(200)})`, "Protection: 2 years"], edit: true }),
  },
  {
    label: "a bundle's add-ons, priced into the line and never editable inputs",
    key: "k8",
    item: { ...shirt, price: 250, adjustments: [{ key: "_adjustment", label: "Gift wrap", displayValue: "Gold", priceMinor: 10_000, appId: "acme.wrap" }] },
    // An add-on's label is the page's word for one ("Add-on"), whatever the app froze.
    shows: shown({ amount: formatMoney(250), components: [`Add-on: Gold (+${formatMoney(100)})`] }),
  },
  {
    label: "a digital line in a cart that ships something else",
    key: "k9",
    item: { ...shirt, fulfillmentKind: "digital" },
    others: [physical],
    shows: shown({ fulfilment: "digital" }),
  },
  {
    label: "a free-delivery product",
    key: "k10",
    item: { ...shirt, freeDelivery: true, fulfillmentKind: "physical" },
    shows: shown({ fulfilment: "ships-free" }),
  },
];

const texts = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent?.trim() ?? "");

/** What one drawn line shows, read through the hooks both renderers emit. */
export function shownCartLine(line: Element): CartLineShown {
  const price = line.querySelector("[data-cart-line-price]");
  return {
    name: line.querySelector("[data-cart-line-name]")?.textContent?.trim() ?? "",
    options: texts(line, "[data-cart-line-option]"),
    purchaseOptions: texts(line, "[data-cart-line-purchase-option]"),
    inputs: texts(line, "[data-property-key]"),
    components: texts(line, "[data-cart-line-component]"),
    edit: line.querySelector("[data-cart-line-edit]") !== null,
    fulfilment: (line.querySelector("[data-cart-line-fulfilment]")?.getAttribute("data-cart-line-fulfilment") ?? null) as CartLineFulfilmentNote | null,
    quantity: line.querySelector("[data-cart-line-quantity]")?.textContent?.trim() ?? "",
    amount: price?.querySelector("[data-cart-line-amount]")?.textContent?.trim() ?? "",
    compareAt: price?.querySelector("[data-cart-line-compare-at]")?.textContent?.trim() ?? null,
    free: price?.hasAttribute("data-cart-line-free") ?? false,
    unitPrice: (() => {
      const unit = line.querySelector("[data-cart-line-unit-price]")?.textContent?.trim();
      return unit ? unit.slice(0, unit.lastIndexOf(" ")) : null;
    })(),
  };
}
