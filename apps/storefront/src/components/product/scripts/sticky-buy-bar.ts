import { BUY_FORM_PLACED_PART, buyFormPart, buyFormScopes } from "../lib/buy-scope";

type BoundBar = HTMLElement & { __stickyBuyCleanup?: () => void };

/**
 * Wires the buy bar (bottom on phones, under the header on computers) to the
 * page's own buy controls: it appears once `#product-actions` has scrolled
 * above the viewport, mirrors the live price and the Add to cart
 * label/disabled state, and its button presses the real Add to cart, so
 * options, stock and cart rules stay in one place.
 *
 * While a phone bar shows, `data-sticky-buy-visible` on the root element
 * lets the bar's stylesheet reserve room below the page and keep focused
 * elements clear of it (WCAG 2.4.11), so the footer stays reachable. A
 * computer-only bar (`data-sticky-buy-screens="desktop"`) reserves nothing.
 */
export function bindStickyBuyBar(bar: BoundBar, root: Document): void {
  bar.__stickyBuyCleanup?.();
  // The buy form's own parts (host-only roles), never an app's look-alike
  // markup: in its container, or placed apart by a skin (lib/buy-scope.ts).
  const summary = root.querySelector<HTMLElement>("[data-sx-product-summary]");
  const scopes = summary ? buyFormScopes(root, summary) : [];
  const main = buyFormPart<HTMLButtonElement>(scopes, "add");
  const action = bar.querySelector<HTMLButtonElement>("[data-sticky-buy-action]");
  const price = bar.querySelector<HTMLElement>("[data-sticky-buy-price]");
  const mainPrice = buyFormPart(scopes, "price");
  // The bar shows once the buttons have scrolled away: the form's body, or the buttons' own row placed apart.
  const formBody = summary?.querySelector<HTMLElement>('[data-sx-buy="actions"]') ?? null;
  const actions = main && formBody?.contains(main) ? formBody : main?.closest<HTMLElement>(`[${BUY_FORM_PLACED_PART}]`) ?? null;
  // A skin without the form's own buttons (`actions={false}`) gets no bar pressing them.
  if (!actions || !main || !action || !price || main.closest("[data-sx-buy-off]")) return;

  const sync = () => {
    price.textContent = mainPrice?.textContent?.trim() ?? "";
    const label = main.querySelector("[data-action-label]")?.textContent?.trim();
    if (label) action.textContent = label;
    action.disabled = main.disabled;
  };

  const reserves = bar.dataset.stickyBuyScreens !== "desktop";
  const show = (visible: boolean) => {
    bar.classList.toggle("invisible", !visible);
    bar.classList.toggle("translate-y-full", !visible);
    bar.inert = !visible;
    root.documentElement.toggleAttribute("data-sticky-buy-visible", reserves && visible);
  };

  const onPress = () => main.click();

  const mirror = new MutationObserver(sync);
  mirror.observe(main, { attributes: true, childList: true, subtree: true, characterData: true });
  if (mainPrice) mirror.observe(mainPrice, { childList: true, subtree: true, characterData: true });

  const visibility = new IntersectionObserver(([entry]) => {
    // Only once the buttons are above the fold, not while still below it.
    show(Boolean(entry && !entry.isIntersecting && entry.boundingClientRect.bottom < 0));
  });
  visibility.observe(actions);

  action.addEventListener("click", onPress);
  sync();

  bar.__stickyBuyCleanup = () => {
    mirror.disconnect();
    visibility.disconnect();
    action.removeEventListener("click", onPress);
    show(false);
  };
}
