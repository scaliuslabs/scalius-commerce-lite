import { pagePath } from "../../lib/presence-url";

// A presence page's product links already carry its prefix.
const cardLink = (card: Element) => card.querySelector<HTMLAnchorElement>('a[href*="/products/"]')?.getAttribute("href");

export function setupEndlessGrids(): void {
  document.querySelectorAll<HTMLElement>("[data-endless-grid]").forEach((section) => {
    const more = section.querySelector<HTMLAnchorElement>("[data-endless-more]");
    const grid = section.querySelector<HTMLElement>(".product-grid");
    if (!more || !grid || more.dataset.ready === "true") return;
    more.dataset.ready = "true";
    more.addEventListener("click", async (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      if (more.getAttribute("aria-busy") === "true") return;
      more.setAttribute("aria-busy", "true");
      const href = more.href;
      try {
        const response = await fetch(href, { credentials: "same-origin" });
        if (!response.ok) throw new Error(String(response.status));
        const listing = new DOMParser().parseFromString(await response.text(), "text/html");
        const results = listing.querySelector("[data-catalog-layout]");
        if (!results) throw new Error("Missing listing");
        const cards = Array.from(results.querySelectorAll('.product-grid > [data-theme-component="product-card"]'));
        if (!cards.length && !results.querySelector("[data-catalog-empty-state]")) throw new Error("Missing listing results");
        // Both paging presentations derive this link from the response's own page/totalPages.
        // A full final page has no next link; its card count alone cannot prove exhaustion.
        const next = results.querySelector<HTMLAnchorElement>("[data-catalog-paging] a[data-catalog-load-more], nav[data-catalog-pagination] a[data-catalog-next]")?.getAttribute("href");
        let nextUrl: URL | null = null;
        if (next) {
          const currentUrl = new URL(href);
          nextUrl = new URL(pagePath(next), currentUrl);
          const page = Number(currentUrl.searchParams.get("page") || 1);
          const nextPage = Number(nextUrl.searchParams.get("page") || 1);
          if (!cards.length || nextUrl.origin !== currentUrl.origin || nextUrl.pathname !== currentUrl.pathname || !Number.isSafeInteger(nextPage) || nextPage <= page) {
            throw new Error("Invalid listing continuation");
          }
        }
        if (cards.some((card) => !cardLink(card))) throw new Error("Missing product link");
        const shown = new Set(Array.from(grid.children).map(cardLink));
        const sizes = grid.querySelector("img[sizes]")?.getAttribute("sizes");
        for (const card of cards) {
          const link = cardLink(card);
          if (shown.has(link)) continue;
          shown.add(link);
          card.querySelectorAll("img").forEach((image) => {
            image.loading = "lazy";
            image.removeAttribute("fetchpriority");
            if (sizes && image.hasAttribute("sizes")) image.setAttribute("sizes", sizes);
          });
          grid.append(document.importNode(card, true));
        }
        if (nextUrl) more.href = nextUrl.href;
        else more.remove();
      } catch {
        // Preserve the ordinary navigation fallback; failed reads are not an empty catalog.
        window.location.href = href;
      } finally {
        more.removeAttribute("aria-busy");
      }
    });
  });
}
