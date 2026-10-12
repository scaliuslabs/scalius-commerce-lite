/** Shared sticky geometry belongs to the host, regardless of who draws the header. */
type StickyBox = { element: HTMLElement; height: number; inset: number };

function firstStickyBox(elements: Iterable<HTMLElement>, reserveDesktopBar = false): StickyBox | null {
  for (const element of elements) {
    const style = getComputedStyle(element);
    // A desktop buy bar appears as its purchase controls leave view. Reserve
    // its space before anchor navigation triggers that visibility change.
    const reserveHidden = reserveDesktopBar && element.dataset.productTopbar === "desktop";
    if ((style.position !== "sticky" && style.position !== "fixed")
      || style.display === "none" || style.display === "contents"
      || (!reserveHidden && (style.visibility === "hidden" || style.visibility === "collapse"
        || style.opacity === "0"))) continue;
    const inset = Number.parseFloat(style.top);
    if (!Number.isFinite(inset)) continue; // A bottom-only phone bar does not obstruct the top.
    const height = element.offsetHeight;
    if (height > 0) return { element, height, inset };
  }
  return null;
}

/**
 * Publishes the declared box's stuck size, not its current viewport Y position.
 * Transforms deliberately leave its layout reservation unchanged: sliding it
 * away leaves a conservative gap. Authors keep visual content inside the
 * declared box; transforms that enlarge it are outside this contract.
 */
export function bindStorefrontChrome(root: Document): () => void {
  const host = root.querySelector<HTMLElement>("[data-storefront-header]");
  const bars = [...root.querySelectorAll<HTMLElement>("[data-product-topbar]")];
  let stopped = false;
  let frame = 0;
  let observed: HTMLElement[] = [];
  const set = (property: string, height: number) => {
    const value = `${Math.max(0, height)}px`;
    if (root.documentElement.style.getPropertyValue(property) !== value) root.documentElement.style.setProperty(property, value);
  };
  const schedule = () => {
    if (!stopped && !frame) frame = requestAnimationFrame(update);
  };
  const resize = new ResizeObserver(schedule);
  function update() {
    frame = 0;
    if (stopped) return;
    const header = firstStickyBox(host?.querySelectorAll<HTMLElement>("[data-sticky-header]") ?? []);
    const product = firstStickyBox(bars.filter((bar) => bar.isConnected
      // A bottom-fixed phone bar's computed top can be a used pixel value.
      // Its declaration, rather than that coordinate, identifies top placement.
      && (bar.dataset.productTopbar !== "desktop" || window.matchMedia("(min-width: 64rem)").matches)), true);
    set("--header-height", header ? header.inset + header.height : 0);
    set("--product-sticky-height", product?.height ?? 0);
    const next = [header?.element, product?.element].filter((element): element is HTMLElement => Boolean(element));
    if (next.length !== observed.length || next.some((element, index) => element !== observed[index])) {
      resize.disconnect();
      next.forEach((element) => resize.observe(element));
      observed = next;
    }
  }
  const mutations = new MutationObserver(schedule);
  const options = { attributes: true, attributeFilter: ["class", "style", "data-sticky-header", "hidden", "popover"], childList: true, subtree: true };
  if (host) mutations.observe(host, options);
  bars.forEach((bar) => mutations.observe(bar, options));
  // A breakpoint can change which box sticks without changing its dimensions.
  window.addEventListener("resize", schedule, { passive: true });
  update();
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener("resize", schedule);
    set("--header-height", 0);
    set("--product-sticky-height", 0);
  };
}

let installed = false;
let cleanup: (() => void) | undefined;

export function installStorefrontChrome(): void {
  if (installed) return;
  installed = true;
  const bind = () => { cleanup?.(); cleanup = bindStorefrontChrome(document); };
  bind();
  document.addEventListener("astro:before-swap", () => { cleanup?.(); cleanup = undefined; });
  document.addEventListener("astro:page-load", bind);
}
