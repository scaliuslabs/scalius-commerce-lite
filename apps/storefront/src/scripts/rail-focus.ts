// A horizontal rail (`data-h-rail`) keeps a focused item fully inside its
// scrollport, with room for the focus ring, so keyboard users never land on a
// clipped card (WCAG 2.4.7, 2.4.11). One delegated listener serves every rail:
// home rails, recently viewed, brands and the cart drawer.

const RING_ROOM_PX = 8;

export function revealFocusedRailItem(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const rail = target.closest<HTMLElement>("[data-h-rail]");
  if (!rail) return;
  let item: Element = target;
  while (item.parentElement && item.parentElement !== rail) item = item.parentElement;
  if (item.parentElement !== rail) return;
  const box = rail.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  const start = rect.left - (box.left + RING_ROOM_PX);
  const end = rect.right - (box.right - RING_ROOM_PX);
  const left = start < 0 ? start : end > 0 ? Math.min(end, start) : 0;
  if (left !== 0) rail.scrollBy({ left, behavior: "auto" });
}

export function installRailFocus(): void {
  document.addEventListener("focusin", (event) => revealFocusedRailItem(event.target));
}
