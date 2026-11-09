import { BUY_FORM_PLACED_PART, buyFormPart, buyFormQueryAll, buyFormScopes } from "../lib/buy-scope";

type BoundBar = HTMLElement & { __stickyBuyCleanup?: () => void };

/**
 * Wires the buy bar (bottom on phones, under the header on computers) to the
 * page's own buy controls: it appears once `#product-actions` has scrolled
 * above the viewport, mirrors the live price and the Add to cart
 * label/disabled state, and its button presses the real Add to cart, so
 * options, stock and cart rules stay in one place.
 *
 * On a phone the bar also shows before the buyer has reached the buy form
 * (a tall gallery pushes it past the fold), and only then: it never lies
 * over the form's options, quantity or buttons. A product with a choice to
 * make ("Size": S, M, L) gets "Choose options" there, which takes the buyer
 * to the options instead of adding a preselected variant they have not seen;
 * a product with nothing to choose adds at once. Once the form has scrolled
 * above, the bar adds and names the choice ("Red / S"). Under the header on
 * computers it shows only once the form has scrolled above.
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

  const variant = bar.querySelector<HTMLElement>("[data-sticky-buy-variant]");
  const chooseLabel = action.dataset.chooseLabel ?? "";
  // The form's option axes with more than one value: a choice the buyer makes.
  const groups = buyFormQueryAll(scopes, '[data-sx-buy="option-group"]');
  const choices = groups.filter((group) =>
    group.querySelectorAll('[data-sx-buy="option"]').length > 1
    || group.querySelectorAll('[data-sx-buy="option-select"] option[value]:not([value=""])').length > 1);
  /** The chosen value of each axis, as the form shows it ("Red / S"); empty while one is unchosen. */
  const chosen = (): string => {
    const values = choices.map((group) => {
      const select = group.querySelector<HTMLSelectElement>('[data-sx-buy="option-select"]');
      if (select) return select.selectedOptions[0]?.dataset.optionValue ?? "";
      return group.querySelector<HTMLElement>('[data-sx-buy="option"][aria-pressed="true"]')?.dataset.optionValue ?? "";
    });
    return values.every(Boolean) ? values.join(" / ") : "";
  };
  // "choose": the buyer has not reached the options yet; "add": the bar presses the form's Add to cart.
  let mode: "add" | "choose" = "add";

  const sync = () => {
    price.textContent = mainPrice?.textContent?.trim() ?? "";
    if (mode === "choose") {
      action.textContent = chooseLabel;
      action.disabled = false;
      if (variant) variant.hidden = true;
      return;
    }
    const label = main.querySelector("[data-action-label]")?.textContent?.trim();
    if (label) action.textContent = label;
    action.disabled = main.disabled;
    if (variant) {
      variant.textContent = chosen();
      variant.hidden = !variant.textContent;
    }
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

  const onPress = () => {
    if (mode === "add") {
      main.click();
      return;
    }
    // Take the buyer to the choice: the first axis's first control, focused.
    const first = choices[0];
    (first ?? actions).scrollIntoView({ block: "center", behavior: root.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const control = first?.querySelector<HTMLElement>('[data-sx-buy="option"][aria-pressed="true"]')
      ?? first?.querySelector<HTMLElement>('[data-sx-buy="option"], [data-sx-buy="option-select"]');
    control?.focus({ preventScroll: true });
  };

  const mirror = new MutationObserver(sync);
  mirror.observe(main, { attributes: true, childList: true, subtree: true, characterData: true });
  if (mainPrice) mirror.observe(mainPrice, { childList: true, subtree: true, characterData: true });
  for (const group of choices) mirror.observe(group, { attributes: true, attributeFilter: ["aria-pressed"], subtree: true });
  for (const group of choices) group.addEventListener("change", sync);

  // Above: the form (its whole body) has scrolled away. Unreached: no part of
  // it has come above the bar's line yet, so the bar covers none of it.
  // Unreached counts on a phone only.
  let above = false;
  let unreached = false;
  const place = () => {
    const before = !above && unreached && onPhone();
    mode = before && choices.length > 0 ? "choose" : "add";
    sync();
    show(above || before);
  };
  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) above = !entry.isIntersecting && entry.boundingClientRect.bottom < 0;
    place();
  });
  visibility.observe(actions);
  // The bar's line: the viewport less the bar's own height, rebuilt when the bar's height changes.
  let reach: IntersectionObserver | null = null;
  let reachMargin = -1;
  const watchReach = () => {
    const margin = Math.ceil(bar.getBoundingClientRect().height);
    if (margin === reachMargin && reach) return;
    reachMargin = margin;
    reach?.disconnect();
    const below = new Map<Element, boolean>();
    reach = new IntersectionObserver((entries) => {
      for (const entry of entries) below.set(entry.target, !entry.isIntersecting && entry.boundingClientRect.top > 0);
      // The buttons and every option axis (a skin may place them apart) are all still below the line.
      unreached = below.size > 0 && [...below.values()].every(Boolean);
      place();
    }, { rootMargin: `0px 0px -${margin}px 0px` });
    for (const target of new Set<Element>([actions, ...choices])) reach.observe(target);
  };
  watchReach();
  const resizedReach = typeof ResizeObserver === "function" ? new ResizeObserver(watchReach) : null;
  resizedReach?.observe(bar);
  phone?.addEventListener?.("change", place);

  action.addEventListener("click", onPress);
  sync();

  bar.__stickyBuyCleanup = () => {
    mirror.disconnect();
    visibility.disconnect();
    reach?.disconnect();
    resized?.disconnect();
    resizedReach?.disconnect();
    for (const group of choices) group.removeEventListener("change", sync);
    phone?.removeEventListener?.("change", place);
    action.removeEventListener("click", onPress);
    show(false);
    html.removeAttribute("data-sticky-buy-reserve");
    html.style.removeProperty("--sticky-buy-reserve");
  };
}
