type BoundBar = HTMLElement & { __stickyBuyCleanup?: () => void };

/**
 * Wires the phone buy bar to the page's own buy controls: it appears once
 * `#product-actions` has scrolled above the viewport, mirrors the live price
 * and the Add to cart label/disabled state, and its button presses the real
 * Add to cart, so options, stock and cart rules stay in one place.
 */
export function bindStickyBuyBar(bar: BoundBar, root: Document): void {
  bar.__stickyBuyCleanup?.();
  const actions = root.getElementById("product-actions");
  const main = root.querySelector<HTMLButtonElement>('[data-action="add-to-cart"]');
  const action = bar.querySelector<HTMLButtonElement>("[data-sticky-buy-action]");
  const price = bar.querySelector<HTMLElement>("[data-sticky-buy-price]");
  const mainPrice = root.querySelector<HTMLElement>(".product-price");
  if (!actions || !main || !action || !price) return;

  const sync = () => {
    price.textContent = mainPrice?.textContent?.trim() ?? "";
    const label = main.querySelector("[data-action-label]")?.textContent?.trim();
    if (label) action.textContent = label;
    action.disabled = main.disabled;
  };

  const show = (visible: boolean) => {
    bar.classList.toggle("invisible", !visible);
    bar.classList.toggle("translate-y-full", !visible);
    bar.inert = !visible;
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
