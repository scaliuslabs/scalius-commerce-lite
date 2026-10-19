/**
 * The cart summary's discount area: one line per applied discount, every code
 * the buyer applied (with why it does or does not apply and what to do), and
 * automatic Buy X get Y offers the buyer can complete. Pure DOM rendering from
 * the server's discount facts; amounts always come from the server.
 */
import { formatMoney } from "@/lib/currency";
import { formatCheckoutLanguageText, formatDiscountLineLabel } from "@scalius/shared/checkout-language-format";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import {
  discountLineKey,
  type CheckoutDiscountFacts,
  type CheckoutDiscountOffer,
  type CheckoutRejectedCode,
} from "../checkout/tax-quote-contract";
import { pagePath } from "@/lib/presence-url";

export interface DiscountPanelActions {
  removeCode(code: string): void;
  /** One-tap add of a simple product that completes an offer. */
  addOfferProduct(offer: CheckoutDiscountOffer, productIndex: number): void;
  focusPhone(): void;
}

function itemNames(offer: CheckoutDiscountOffer | undefined): string {
  return offer?.products.map(({ name }) => name).join(" / ") ?? "";
}

/** The buyer-facing reason a code adds nothing, in the checkout language. */
export function describeRejectedCode(
  rejection: CheckoutRejectedCode,
  copy: CheckoutLanguageData,
): string {
  const text = (template: string, values: Record<string, string | number>) =>
    formatCheckoutLanguageText(template, values);
  const { code, offer } = rejection;
  const item = itemNames(offer);
  switch (rejection.reason) {
    case "not_found":
      return copy.invalidDiscountCodeText;
    case "needs_phone":
      return text(copy.discountNeedsPhoneText, { code });
    case "minimum_subtotal":
      return rejection.shortfallAmount !== undefined
        ? text(copy.discountMinimumSubtotalText, { code, amount: formatMoney(rejection.shortfallAmount) })
        : rejection.message;
    case "minimum_quantity":
      return rejection.shortfallQuantity !== undefined
        ? text(
            rejection.shortfallQuantity === 1 ? copy.discountMinimumQuantityOneText : copy.discountMinimumQuantityText,
            { code, count: rejection.shortfallQuantity },
          )
        : rejection.message;
    case "get_items":
      if (!offer || !item) return rejection.message;
      return offer.percentOff >= 100
        ? text(copy.discountGetFreeText, { item })
        : text(copy.discountGetPercentText, { item, percent: offer.percentOff });
    case "buy_items":
      if (!offer || !item) return rejection.message;
      return offer.shortfallAmount !== null
        ? text(copy.discountSpendMoreText, { code, item, amount: formatMoney(offer.shortfallAmount) })
        : text(copy.discountBuyMoreText, { code, item, count: offer.quantity });
    case "not_combinable":
      return rejection.conflictsWith
        ? text(copy.discountNotCombinableText, { code, other: rejection.conflictsWith })
        : rejection.message;
    case "lower_savings":
      if (rejection.bundleSavesMore) return text(copy.discountBundleBetterText, { code });
      return rejection.conflictsWith
        ? text(copy.discountLowerSavingsThanText, { other: rejection.conflictsWith })
        : copy.discountLowerSavingsText;
    case "needs_delivery":
      return text(copy.discountNeedsDeliveryText, { code });
    case "delivery_discount_applied":
      return rejection.conflictsWith
        ? text(copy.discountOneDeliveryText, { other: rejection.conflictsWith })
        : copy.discountLowerSavingsText;
    default:
      return rejection.message;
  }
}

/** Reasons the buyer can fix by changing the cart: the code stays applied and is re-checked. */
export function isPendingCodeReason(reason: CheckoutRejectedCode["reason"]): boolean {
  return reason === "needs_phone"
    || reason === "needs_delivery"
    || reason === "minimum_subtotal"
    || reason === "minimum_quantity"
    || reason === "get_items"
    || reason === "buy_items";
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ACTION_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-9";

/**
 * The items that complete an offer, one row each: the name (one line, cut
 * with an ellipsis, the full name on hover and to assistive technology) and
 * a short action that never wraps: Add for a simple product, Choose options
 * (its page) for one with options.
 */
function offerActions(
  offer: CheckoutDiscountOffer,
  copy: CheckoutLanguageData,
  actions: DiscountPanelActions,
): HTMLElement | null {
  if (offer.products.length === 0) return null;
  const list = element("ul", "mt-2 divide-y divide-primary/15");
  offer.products.forEach((product, index) => {
    const row = element("li", "flex min-w-0 items-center gap-2 py-1.5 first:pt-0 last:pb-0");
    const name = element("span", "min-w-0 flex-1 truncate", product.name);
    name.title = product.name;
    row.append(name);
    if (product.variantId) {
      const button = element("button", `${ACTION_CLASS} shrink-0 whitespace-nowrap`, copy.offerAddItemText);
      button.type = "button";
      button.setAttribute("aria-label", `${copy.offerAddItemText} ${product.name}`);
      button.addEventListener("click", () => actions.addOfferProduct(offer, index));
      row.append(button);
    } else {
      const link = element("a", `${ACTION_CLASS} shrink-0 whitespace-nowrap`, copy.offerChooseOptionsText);
      link.setAttribute("aria-label", `${copy.offerChooseOptionsText}: ${product.name}`);
      link.href = pagePath(`/products/${encodeURIComponent(product.slug)}`);
      row.append(link);
    }
    list.append(row);
  });
  return list;
}

/** What an offer gives, as its headline: "Choose your free gift", "Choose an item at 20% off". */
function offerHeadline(offer: CheckoutDiscountOffer, copy: CheckoutLanguageData): string {
  const free = offer.percentOff >= 100;
  if (offer.quantity > 1) {
    return formatCheckoutLanguageText(free ? copy.offerFreeManyHeadingText : copy.offerPercentManyHeadingText, {
      count: offer.quantity,
      percent: offer.percentOff,
    });
  }
  return free ? copy.offerFreeHeadingText : formatCheckoutLanguageText(copy.offerPercentHeadingText, { percent: offer.percentOff });
}

/** Renders the discount lines, applied codes and offers into their containers. */
export function renderDiscountPanel(
  root: ParentNode,
  state: { codes: string[]; facts: CheckoutDiscountFacts | null },
  copy: CheckoutLanguageData,
  actions: DiscountPanelActions,
): void {
  const lines = root.querySelector<HTMLElement>("#discountLines");
  const applied = root.querySelector<HTMLElement>("#appliedCodes");
  const offers = root.querySelector<HTMLElement>("#discountOffers");
  const facts = state.facts;

  // Delivery savings show on the delivery line, so only savings on the items are
  // listed here (a store app's discount too, keyed by its app and position).
  lines?.replaceChildren(...(facts?.discounts ?? []).flatMap((line, position) => {
    if (line.amount <= 0) return [];
    const row = element("div", "flex justify-between gap-3 text-sm text-primary");
    row.dataset.discountLine = discountLineKey(line, position);
    row.append(element("span", "min-w-0", formatDiscountLineLabel(copy.discountText, line)), element("span", "shrink-0 font-medium tabular-nums", `-${formatMoney(line.amount)}`));
    return [row];
  }));

  // Compact code chips in one wrapping row; a code that doesn't apply says why underneath.
  const chips = state.codes.map((code) => {
    const rejection = facts?.rejectedCodes.find((candidate) => candidate.code === code);
    const chip = element(
      "li",
      `inline-flex min-h-9 items-center gap-1 rounded-full border ps-3 text-sm ${rejection ? "border-dashed border-border text-muted-foreground" : "border-primary/40 bg-primary/5 font-medium text-foreground"}`,
    );
    chip.append(element("span", "font-mono", code));
    const remove = element("button", "inline-flex h-9 min-w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring");
    remove.type = "button";
    remove.setAttribute("aria-label", formatCheckoutLanguageText(copy.removeDiscountCodeText, { code }));
    remove.textContent = "×";
    remove.addEventListener("click", () => actions.removeCode(code));
    chip.append(remove);
    return chip;
  });
  const notes = state.codes.flatMap((code) => {
    const rejection = facts?.rejectedCodes.find((candidate) => candidate.code === code);
    if (!rejection) {
      // An applied code that took the place of an automatic discount says so, once.
      const replaced = facts?.discounts.find((line) => line.code === code)?.replaces;
      return replaced
        ? [element("li", "basis-full text-sm text-muted-foreground", formatCheckoutLanguageText(copy.discountReplacesText, { code, other: replaced }))]
        : [];
    }
    const item = element("li", "basis-full text-sm text-muted-foreground");
    item.append(element("p", "", `${code}: ${describeRejectedCode(rejection, copy)}`));
    if (rejection.reason === "needs_phone") {
      const button = element("button", `${ACTION_CLASS} mt-1`, copy.customerPhoneLabel);
      button.type = "button";
      button.addEventListener("click", () => actions.focusPhone());
      item.append(button);
    } else if (rejection.offer && rejection.reason === "get_items") {
      const row = offerActions(rejection.offer, copy, actions);
      if (row) item.append(row);
    }
    return [item];
  });
  applied?.replaceChildren(...chips, ...notes);
  applied?.classList.toggle("hidden", state.codes.length === 0);

  // An earned offer: what it gives, the discount's title, then the items to choose from.
  offers?.replaceChildren(...(facts?.offers ?? []).map((offer) => {
    const item = element("li", "min-w-0 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm text-foreground");
    item.append(element("p", "font-medium", offerHeadline(offer, copy)));
    if (offer.title.trim()) {
      const title = element("p", "line-clamp-2 break-words text-muted-foreground", offer.title);
      title.title = offer.title;
      item.append(title);
    }
    const list = offerActions(offer, copy, actions);
    if (list) item.append(list);
    return item;
  }));
  offers?.classList.toggle("hidden", (facts?.offers.length ?? 0) === 0);
}
