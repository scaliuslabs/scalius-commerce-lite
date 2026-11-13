/**
 * What a cart line shows, computed once from the priced cart: the one model
 * the cart page's line (`cartLineHtml`) and the drawer's line (CartFlyout)
 * both draw, so the two can no longer disagree about a line. Words that
 * differ by surface (the cart page's are the checkout language's, the
 * drawer's the storefront catalogue's) stay with each renderer; every fact
 * and every amount comes from here. `line-view.cases.ts` is the table both
 * renderers are tested against. The lines' order (`cartLineEntries`) and the
 * amounts under them (`cartEstimate`) come from here too, so the drawer and
 * the cart page list the same lines in the same order over the same subtotal
 * (cart-parity.test.tsx draws both from one cart).
 */
import type { LineEntryWords } from "@scalius/shared/line-entry-words";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { isFreeOrderLine } from "@scalius/shared/order-money-presentation";
import { formatMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { pagePath } from "@/lib/presence-url";
import { formatCount } from "@/lib/store-time-zone";
import type { CartValidationIssue } from "@/lib/api/orders";
import { cartItemsSubtotal, cartNeedsDeliveryMethod, type CartItem, type VariantCartItem } from "@/store/cart";
import { cartLineName, normalizeCartItemOptions } from "./item-options";
import { cartLineEditHref, cartLinePropertyText } from "./line-properties-view";

/** A line's share of the store's discounts as the latest quote or preview priced it. */
export interface CartLineDiscount {
  discountMinor: number;
  /** The quantity it was priced at: a share for another quantity says nothing about this one. */
  quantity: number;
  decimalPlaces: number;
}

export interface CartLineViewContext {
  discount?: CartLineDiscount | null;
  /**
   * Units the store can sell of this line: a number, `null` for no known
   * limit, or `"checking"` while the surface waits for its first check.
   */
  quantityLimit?: number | null | "checking";
  /** Some lines of the cart ship and some don't: the ones that don't say so. */
  mixedFulfilment?: boolean;
  /** The platform's words on the line ("Yes", "Add-on") in the page's language. */
  words: LineEntryWords;
  /** How an input's surcharge reads: "+{price}". */
  surchargeText: string;
}

/** The note under a line about how it reaches the buyer. */
export type CartLineFulfilmentNote = "digital" | "service" | "ships-free";

export interface CartLineView {
  key: string;
  /** The product's name as the line stored it. */
  name: string;
  /** The controls' name for the line: its product and option labels ("Shirt (Blue, L)"). */
  lineName: string;
  productHref: string;
  image: string | undefined;
  options: Array<{ name: string; label: string }>;
  /** The apps' ways to buy the line (a subscription), by title. */
  purchaseOptions: Array<{ id: string; title: string }>;
  /** The buyer's inputs, one row each ("Engraving: Ana (+৳200)"); an app's line input is one of them. */
  inputs: Array<{ key: string; text: string }>;
  /** The apps' add-ons priced into the line (protection, gift wrap): rows, never inputs. */
  components: string[];
  /** The product page that edits the line's inputs; null without inputs. */
  editHref: string | null;
  fulfilment: CartLineFulfilmentNote | null;
  quantity: number;
  quantityText: string;
  /** What "−" sets the quantity to (0 removes the line). */
  decreaseTo: number;
  increaseTo: number;
  /** Why "+" is off: no check has said how many are left, or the line holds them all. */
  increaseBlocked: "checking" | "at-limit" | null;
  /** Its own discount pays the line in full (a free gift, the "get" item of a buy-one-get-one). */
  free: boolean;
  /** The line's amount: its price times its quantity, or zero when free. */
  linePrice: string;
  /** The struck amount before the line turned free; null otherwise. */
  compareAt: string | null;
  /** One unit's price, shown when the line holds more than one. */
  unitPrice: string | null;
}

/** Whether a quoted share pays the line in full, for the quantity it holds now. */
export function isFreeCartLine(item: Pick<VariantCartItem, "price" | "quantity">, discount: CartLineDiscount | null | undefined): boolean {
  if (!discount || discount.quantity !== item.quantity) return false;
  return isFreeOrderLine({
    grossSubtotalMinor: toMinor(item.price * item.quantity, discount.decimalPlaces),
    discountMinor: discount.discountMinor,
  });
}

function fulfilmentNote(item: VariantCartItem, mixed: boolean): CartLineFulfilmentNote | null {
  if (mixed && (item.fulfillmentKind === "digital" || item.fulfillmentKind === "service")) return item.fulfillmentKind;
  // A free-delivery product's own delivery is free (its shipping profile), whatever the rest pays.
  return item.freeDelivery === true && (item.fulfillmentKind ?? "physical") === "physical" ? "ships-free" : null;
}

export function cartLineView(key: string, item: VariantCartItem, context: CartLineViewContext): CartLineView {
  const name = item.name || "";
  const properties = item.properties ?? [];
  const free = isFreeCartLine(item, context.discount);
  const amount = item.price * item.quantity;
  const limit = context.quantityLimit;
  return {
    key,
    name,
    lineName: cartLineName({ ...item, name }),
    productHref: pagePath(`/products/${item.slug || item.id}`),
    image: item.image,
    options: (normalizeCartItemOptions(item.options) ?? []).map(({ name: optionName, label }) => ({ name: optionName, label })),
    purchaseOptions: (item.purchaseOptions ?? []).map(({ id, title }) => ({ id, title })),
    inputs: properties.map((property) => ({ key: property.key, text: cartLinePropertyText(property, context.surchargeText, context.words) })),
    components: (item.adjustments ?? []).map((adjustment) => cartLinePropertyText(adjustment, context.surchargeText, context.words)),
    editHref: properties.length > 0 ? cartLineEditHref(item) : null,
    fulfilment: fulfilmentNote(item, context.mixedFulfilment === true),
    quantity: item.quantity,
    quantityText: formatCount(item.quantity),
    decreaseTo: Math.max(0, item.quantity - 1),
    increaseTo: item.quantity + 1,
    increaseBlocked: limit === "checking" ? "checking" : typeof limit === "number" && item.quantity >= limit ? "at-limit" : null,
    free,
    linePrice: formatMoney(free ? 0 : amount),
    compareAt: free ? formatMoney(amount) : null,
    unitPrice: item.quantity > 1 ? formatMoney(item.price) : null,
  };
}

/** Whether some lines ship and some don't (the receipt groups them the same way). */
export function cartHasMixedFulfilment(items: Record<string, Pick<VariantCartItem, "fulfillmentKind">>): boolean {
  return cartNeedsDeliveryMethod(items)
    && Object.values(items).some((item) => item.fulfillmentKind === "digital" || item.fulfillmentKind === "service");
}

/**
 * The cart's lines in the one order every surface lists them: the order the
 * buyer added them (a new line goes last, a line added again keeps its place).
 * The drawer once moved the line just added to the top, so it and the cart
 * page listed one cart in two orders.
 */
export function cartLineEntries<T>(items: Record<string, T>): Array<[string, T]> {
  return Object.entries(items);
}

/** Codes that leave a line with nothing a buyer can buy now (sold out, gone, unavailable). */
const UNBUYABLE_ISSUE_CODES = new Set<CartValidationIssue["code"]>([
  "product_unavailable",
  "variant_unavailable",
  "variant_required",
  "variant_mismatch",
  "fulfilment_unavailable",
]);

/**
 * The lines an estimate can count: a line the server says can't be bought
 * now (sold out, unavailable) is left out, and a line with fewer units left
 * counts only those. Its offers (a buy-one-get-one) go with it. Checkout
 * still takes nothing until the buyer fixes the line.
 */
export function estimableCartLines(
  items: Record<string, CartItem>,
  issues: Record<string, CartValidationIssue[]>,
): { items: Record<string, CartItem>; leftOut: string[] } {
  const counted: Record<string, CartItem> = {};
  const leftOut: string[] = [];
  for (const [cartKey, item] of Object.entries(items)) {
    const lineIssues = issues[cartKey] ?? [];
    const available = lineIssues.reduce<number | null>((limit, issue) => {
      if (UNBUYABLE_ISSUE_CODES.has(issue.code)) return 0;
      if (issue.code === "quantity_unavailable" && typeof issue.availableQuantity === "number") {
        const units = Math.max(0, Math.floor(issue.availableQuantity));
        return limit === null ? units : Math.min(limit, units);
      }
      return limit;
    }, null);
    if (available === 0) {
      leftOut.push(item.name);
      continue;
    }
    counted[cartKey] = available !== null && available < item.quantity ? { ...item, quantity: available } : item;
  }
  return { items: counted, leftOut };
}

/** The amounts under the lines, before delivery: what both cart surfaces show. */
export interface CartEstimate {
  /** The lines the estimate counts (`estimableCartLines`). */
  items: Record<string, CartItem>;
  /** The names of the lines it leaves out. */
  leftOut: string[];
  /** What the counted lines cost. */
  subtotal: number;
  /** The store's discounts on them, as the latest preview priced them. */
  discount: number;
  /** Subtotal less discounts, never below zero: delivery and tax are added at checkout. */
  total: number;
}

export function cartEstimate(
  items: Record<string, CartItem>,
  issues: Record<string, CartValidationIssue[]>,
  discount: number,
): CartEstimate {
  const estimable = estimableCartLines(items, issues);
  const subtotal = cartItemsSubtotal(estimable.items);
  const places = getDecimalPlaces(getCurrencyCode());
  return { ...estimable, subtotal, discount, total: fromMinor(Math.max(0, toMinor(subtotal, places) - toMinor(discount, places)), places) };
}
