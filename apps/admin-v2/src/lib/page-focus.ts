/**
 * Focus moved to the page by code, not by the merchant (a save or discard
 * returning focus, a dialog closing onto nothing): the page region takes it
 * without drawing the focus ring around the whole canvas. Browsers match
 * `:focus-visible` on a programmatic focus that no pointer preceded (a page
 * just loaded), so the region is marked `data-quiet-focus` until it blurs
 * (global.css). Keyboard users still get the ring: Tab onto the region, or
 * the "Skip to content" link, focus it without the mark.
 */
export const PAGE_REGION_ID = "admin-main-scroll";

export function focusPageQuietly(): void {
  const page = document.getElementById(PAGE_REGION_ID);
  if (!page) return;
  page.setAttribute("data-quiet-focus", "");
  page.addEventListener("blur", () => page.removeAttribute("data-quiet-focus"), { once: true });
  page.focus({ preventScroll: true });
}
