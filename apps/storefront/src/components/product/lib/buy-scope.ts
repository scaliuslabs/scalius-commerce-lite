// Where the buy form's parts are. The form is one: its container
// (`[data-sx-product-summary]`) holds every part, except those a product_main
// skin placed apart from it with `<BuyFormPart name="…" />`, which the store
// renders where the skin put them, each in a host-only wrapper
// (`[data-sx-buy-part="<part>"]`). Both markers are host-only: the sanitizer
// strips every `data-sx-*` an app writes, so no app markup (a skin's own, an
// app component in the buy box's slots) ever stands in for a part. Nothing
// is moved in the browser: a placed part is drawn where it shows.

/** The host-only wrapper of a buy form part a skin placed apart (`<BuyFormPart />`). */
export const BUY_FORM_PLACED_PART = "data-sx-buy-part";

/** The form's container, then each placed part's wrapper, in page order. */
export function buyFormScopes(root: ParentNode, summary: Element): Element[] {
  return [summary, ...Array.from(root.querySelectorAll(`[${BUY_FORM_PLACED_PART}]`))];
}

/** The first element matching `selector` in the form's container or a placed part. */
export function buyFormQuery<T extends Element = HTMLElement>(scopes: readonly Element[], selector: string): T | null {
  for (const scope of scopes) {
    const found = scope.querySelector<T>(selector);
    if (found) return found;
  }
  return null;
}

/** Every element matching `selector` in the form's container and its placed parts. */
export function buyFormQueryAll<T extends Element = HTMLElement>(scopes: readonly Element[], selector: string): T[] {
  return scopes.flatMap((scope) => Array.from(scope.querySelectorAll<T>(selector)));
}

/** One of the form's own parts by its host-only role (`data-sx-buy`). */
export function buyFormPart<T extends Element = HTMLElement>(scopes: readonly Element[], role: string): T | null {
  return buyFormQuery<T>(scopes, `[data-sx-buy="${role}"]`);
}
