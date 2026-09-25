// Listing paging and view enhancements. Every mode is plain links first:
// "Load more" is a link to `?page=n+1` and infinite scroll is numbered
// pagination, so crawlers and buyers without JavaScript page through
// ordinary, self-canonical page URLs (Google's guidance for infinite
// scroll). With JavaScript, the next page's own HTML (edge-cached like any
// page) supplies the cards, and the address bar follows the last page shown.

/** "Showing 21–40 of 484 products". */
export function catalogProgressLabel(from: number, to: number, total: number): string {
  const noun = total === 1 ? "product" : "products";
  if (to <= 0) return `${total} ${noun}`;
  return `Showing ${from.toLocaleString("en-IN")}–${to.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} ${noun}`;
}

/** Infinite scroll loads this many pages by itself, then hands over to the button so the footer stays reachable. */
export const CATALOG_INFINITE_AUTO_PAGES = 4;

const RESULTS = "[data-catalog-results]";

interface PagingParts {
  grid: HTMLElement;
  link: HTMLAnchorElement;
  progress: HTMLElement | null;
}

/** The cards and the paging state of a listing page's HTML. */
function readPage(root: ParentNode) {
  const grid = root.querySelector<HTMLElement>(`${RESULTS} .product-grid`);
  const paging = root.querySelector<HTMLElement>("[data-catalog-paging]");
  return {
    cards: grid ? [...grid.children] : [],
    next: paging?.querySelector<HTMLAnchorElement>("a[data-catalog-load-more]")?.getAttribute("href") ?? null,
    to: Number(paging?.querySelector<HTMLElement>("[data-catalog-progress]")?.dataset.to ?? NaN),
  };
}

/**
 * Appends the next page's cards to the grid and resolves to the first new
 * card; null when the page could not be used (the caller then follows the
 * link instead).
 */
export async function loadNextCatalogPage(parts: PagingParts, fetcher: typeof fetch = fetch): Promise<HTMLElement | null> {
  const { grid, link, progress } = parts;
  const href = link.href;
  const response = await fetcher(href, { headers: { Accept: "text/html" }, credentials: "same-origin" });
  if (!response.ok) return null;
  const next = readPage(new DOMParser().parseFromString(await response.text(), "text/html"));
  if (next.cards.length === 0) return null;
  for (const card of next.cards) {
    // Appended photos are below the fold by definition.
    card.querySelectorAll("img").forEach((image) => {
      image.loading = "lazy";
      image.decoding = "async";
      image.removeAttribute("fetchpriority");
    });
  }
  const firstNew = next.cards[0] as HTMLElement;
  grid.append(...next.cards.map((card) => document.adoptNode(card)));
  if (progress && Number.isFinite(next.to)) {
    progress.dataset.to = String(next.to);
    progress.textContent = catalogProgressLabel(Number(progress.dataset.from), next.to, Number(progress.dataset.total));
  }
  history.replaceState(history.state, "", href);
  if (next.next) link.setAttribute("href", next.next);
  else link.remove();
  return firstNew;
}

/** "Load more" and infinite scroll over the server-rendered paging block. */
export function setupCatalogPaging(): void {
  const block = document.querySelector<HTMLElement>("[data-catalog-paging]");
  const grid = document.querySelector<HTMLElement>(`${RESULTS} .product-grid`);
  if (!block || !grid || block.dataset.pagingBound === "true") return;
  const mode = block.dataset.catalogPaging;
  if (mode !== "load-more" && mode !== "infinite") return;
  block.dataset.pagingBound = "true";

  const loader = block.querySelector<HTMLElement>("[data-catalog-load-more-block]");
  const link = block.querySelector<HTMLAnchorElement>("a[data-catalog-load-more]");
  if (!loader || !link) return;
  const progress = block.querySelector<HTMLElement>("[data-catalog-progress]");
  const label = link.textContent ?? "Load more";
  let busy = false;
  let autoPages = 0;
  let observer: IntersectionObserver | undefined;

  const load = async (auto: boolean) => {
    if (busy || !link.isConnected) return;
    busy = true;
    link.setAttribute("aria-busy", "true");
    link.textContent = "Loading…";
    const target = link.href;
    const firstNew = await loadNextCatalogPage({ grid, link, progress }).catch(() => null);
    if (!firstNew) {
      window.location.href = target;
      return;
    }
    busy = false;
    link.removeAttribute("aria-busy");
    link.textContent = label;
    if (!auto) {
      // Keyboard and screen-reader users continue at the first new product.
      firstNew.querySelector<HTMLElement>("a[href]")?.focus();
    }
    if (!link.isConnected || (auto && ++autoPages >= CATALOG_INFINITE_AUTO_PAGES)) observer?.disconnect();
  };

  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void load(false);
  });

  if (mode === "infinite") {
    // The numbered pagination stays for crawlers and without JavaScript.
    block.querySelector<HTMLElement>("nav[aria-label='Pagination']")?.setAttribute("hidden", "");
    loader.hidden = false;
    if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Well ahead of the reader, so the next cards land below the screen
      // and nothing the buyer sees moves (CLS).
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load(true);
      }, { rootMargin: "1600px 0px" });
      observer.observe(loader);
    }
  }
}

export const CATALOG_VIEW_STORAGE_KEY = "scalius:listing-view";

/** The grid/list toggle (Daraz): a per-browser preference, applied before the grid paints. */
export function setupCatalogViewToggle(): void {
  const toggle = document.querySelector<HTMLElement>("[data-catalog-view-toggle]");
  const frame = document.querySelector<HTMLElement>(RESULTS);
  if (!toggle || !frame || toggle.dataset.toggleBound === "true") return;
  toggle.dataset.toggleBound = "true";
  const buttons = [...toggle.querySelectorAll<HTMLButtonElement>("button[data-view]")];
  const sync = () => buttons.forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.view === frame.dataset.catalogResults)));
  buttons.forEach((button) => button.addEventListener("click", () => {
    const view = button.dataset.view === "list" ? "list" : "grid";
    frame.dataset.catalogResults = view;
    try {
      localStorage.setItem(CATALOG_VIEW_STORAGE_KEY, view);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
    sync();
  }));
  sync();
}
