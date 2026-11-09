import { BUY_FORM_PLACED_PART, buyFormPart, buyFormScopes } from "../lib/buy-scope";

type BoundBar = HTMLElement & { __stickyBuyCleanup?: () => void };

/**
 * Wires the buy bar (bottom on phones, under the header on computers) to the
 * page's own buy controls: it appears once `#product-actions` has scrolled
 * above the viewport, mirrors the live price and the Add to cart
 * label/disabled state, and its button presses the real Add to cart, so
 * options, stock and cart rules stay in one place.
 *
 * On a phone the bar also shows while the buttons are still below the
 * screen (a tall gallery and options push them past the fold), so the buy
 * action is in reach without scrolling; under the header on computers it
 * shows only once they have scrolled above.
 *
 * A phone bar reserves its measured height below the page for as long as it
 * is bound (`data-sticky-buy-reserve`, `--sticky-buy-reserve`), shown or not:
 * a reserve added only when the bar appears grew the page under a buyer
 * already at its end, so the bar covered the footer's last links. Focused
 * elements scroll clear of it (WCAG 2.4.11). `data-sticky-buy-visible` says
 * when it shows (the phone tab bar steps aside). A computer-only bar
 * (`data-sticky-buy-screens="desktop"`) reserves nothing.
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
  const html = root.documentElement;
  const view = root.defaultView;
  // Where the phone bar is drawn (the stylesheet's breakpoint): there it is pinned to the bottom.
  const phone = view?.matchMedia?.("(max-width: 63.999rem)");
  const onPhone = () => reserves && (phone?.matches ?? true);
  const show = (visible: boolean) => {
    bar.classList.toggle("invisible", !visible);
    bar.classList.toggle("translate-y-full", !visible);
    bar.inert = !visible;
    html.toggleAttribute("data-sticky-buy-visible", reserves && visible);
  };
  // The reserve is the bar's own height as drawn (a wrapped label, the safe-area inset), never a guess.
  const reserve = () => {
    html.toggleAttribute("data-sticky-buy-reserve", reserves);
    const height = bar.getBoundingClientRect().height;
    if (reserves && height > 0) html.style.setProperty("--sticky-buy-reserve", `${Math.ceil(height)}px`);
  };
  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(reserve) : null;
  resized?.observe(bar);
  reserve();

  const onPress = () => main.click();

  const mirror = new MutationObserver(sync);
  mirror.observe(main, { attributes: true, childList: true, subtree: true, characterData: true });
  if (mainPrice) mirror.observe(mainPrice, { childList: true, subtree: true, characterData: true });

  // Above: the form's buttons (their whole row) have scrolled away. Below: the
  // Add to cart button itself has not reached the screen yet (the options
  // above it may already show). Below counts on a phone only.
  let above = false;
  let below = false;
  const place = () => show(above || (below && onPhone()));
  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const out = !entry.isIntersecting;
      if (entry.target === actions) above = out && entry.boundingClientRect.bottom < 0;
      if (entry.target === main) below = out && entry.boundingClientRect.top > 0;
    }
    place();
  });
  visibility.observe(actions);
  if (main !== actions) visibility.observe(main);
  phone?.addEventListener?.("change", place);

  action.addEventListener("click", onPress);
  sync();

  bar.__stickyBuyCleanup = () => {
    mirror.disconnect();
    visibility.disconnect();
    resized?.disconnect();
    phone?.removeEventListener?.("change", place);
    action.removeEventListener("click", onPress);
    show(false);
    html.removeAttribute("data-sticky-buy-reserve");
    html.style.removeProperty("--sticky-buy-reserve");
  };
}
