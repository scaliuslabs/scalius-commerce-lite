/**
 * The cart summary's discount area: one line per applied discount, every code
 * the buyer applied (with why it does or does not apply and what to do), and
 * automatic Buy X get Y offers the buyer can complete. Pure DOM rendering from
 * the server's discount facts; amounts always come from the server.
 */
import { formatMoney } from "@scalius/shared/currency";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import type {
  CheckoutDiscountFacts,
  CheckoutDiscountOffer,
  CheckoutRejectedCode,
} from "../checkout/tax-quote-contract";

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
        ? text(copy.discountMinimumQuantityText, { code, count: rejection.shortfallQuantity })
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
      return copy.discountLowerSavingsText;
    default:
      return rejection.message;
  }
}

/** Reasons the buyer can fix by changing the cart: the code stays applied and is re-checked. */
export function isPendingCodeReason(reason: CheckoutRejectedCode["reason"]): boolean {
  return reason === "needs_phone"
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
  "inline-flex min-h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function offerActions(
  offer: CheckoutDiscountOffer,
  copy: CheckoutLanguageData,
  actions: DiscountPanelActions,
): HTMLElement | null {
  if (offer.products.length === 0) return null;
  const row = element("div", "mt-1 flex flex-wrap gap-2");
  offer.products.forEach((product, index) => {
    if (product.variantId) {
      const button = element("button", ACTION_CLASS, `${copy.offerAddItemText} ${product.name}`);
      button.type = "button";
      button.addEventListener("click", () => actions.addOfferProduct(offer, index));
      row.append(button);
    } else {
      const link = element("a", ACTION_CLASS, `${copy.offerChooseOptionsText}: ${product.name}`);
      link.href = `/products/${encodeURIComponent(product.slug)}`;
      row.append(link);
    }
  });
  return row;
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

  lines?.replaceChildren(...(facts?.discounts ?? []).map((line) => {
    const row = element("div", "flex justify-between gap-3 text-sm text-primary");
    const label = line.code && line.code !== line.title ? `${line.title} · ${line.code}` : line.title;
    row.append(element("span", "min-w-0", label), element("span", "shrink-0 font-medium tabular-nums", `-${formatMoney(line.amount)}`));
    return row;
  }));

  applied?.replaceChildren(...state.codes.map((code) => {
    const rejection = facts?.rejectedCodes.find((candidate) => candidate.code === code);
    const item = element("li", "rounded-lg border border-border bg-background px-3 py-2");
    const head = element("div", "flex items-center justify-between gap-2");
    head.append(element("span", rejection ? "font-mono text-sm text-muted-foreground" : "font-mono text-sm font-medium text-foreground", code));
    const remove = element("button", "inline-flex h-9 min-w-9 items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring");
    remove.type = "button";
    remove.setAttribute("aria-label", formatCheckoutLanguageText(copy.removeDiscountCodeText, { code }));
    remove.textContent = "×";
    remove.addEventListener("click", () => actions.removeCode(code));
    head.append(remove);
    item.append(head);
    if (rejection) {
      item.append(element("p", "mt-1 text-sm text-muted-foreground", describeRejectedCode(rejection, copy)));
      if (rejection.reason === "needs_phone") {
        const button = element("button", `${ACTION_CLASS} mt-1`, copy.customerPhoneLabel);
        button.type = "button";
        button.addEventListener("click", () => actions.focusPhone());
        item.append(button);
      } else if (rejection.offer && rejection.reason === "get_items") {
        const row = offerActions(rejection.offer, copy, actions);
        if (row) item.append(row);
      }
    }
    return item;
  }));
  applied?.classList.toggle("hidden", state.codes.length === 0);

  offers?.replaceChildren(...(facts?.offers ?? []).map((offer) => {
    const item = element("li", "rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground");
    item.append(element("p", "font-medium", offer.title));
    const detail = describeRejectedCode(
      { code: "", reason: "get_items", message: offer.title, offer },
      copy,
    );
    item.append(element("p", "text-muted-foreground", detail));
    const row = offerActions(offer, copy, actions);
    if (row) item.append(row);
    return item;
  }));
  offers?.classList.toggle("hidden", (facts?.offers.length ?? 0) === 0);
}
