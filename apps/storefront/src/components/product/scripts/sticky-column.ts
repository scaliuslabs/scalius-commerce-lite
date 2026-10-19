/**
 * A sticky column taller than the window (a buy box beside a long gallery):
 * plain `position: sticky; top` would pin its top and hide its end until the
 * photos run out. Here the column scrolls with the page until its end is in
 * view, stays there while the buyer keeps scrolling down, and scrolls back
 * with the page on the way up until its top is pinned again (Shopify
 * Horizon's sticky content, the classic "sticky sidebar").
 *
 * Contract: `[data-sticky-column]` elements with `position: sticky` write
 * their top as `calc(<offset> + var(--sticky-column-shift, 0px))`. This sets
 * the shift (0 or negative px). A column that fits the window keeps 0, so it
 * behaves as before. Each scroll frame does arithmetic and one style write;
 * sizes are read only when the column or the window resizes.
 */

const GAP_PX = 16;
const SHIFT = "--sticky-column-shift";

type Column = { element: HTMLElement; offset: number; height: number; shift: number; sticky: boolean };

/** The next shift for a scroll by `delta`: between "end in view" and 0 (top pinned). */
export function nextStickyShift(column: Pick<Column, "offset" | "height" | "shift">, delta: number, viewport: number, gap = GAP_PX): number {
  const lowest = Math.min(0, viewport - gap - column.offset - column.height);
  return Math.max(lowest, Math.min(0, column.shift - delta));
}

export function installStickyColumns(doc: Document = document): () => void {
  const view = doc.defaultView;
  const elements = Array.from(doc.querySelectorAll<HTMLElement>("[data-sticky-column]"));
  if (!view || elements.length === 0) return () => {};
  const columns: Column[] = elements.map((element) => ({ element, offset: 0, height: 0, shift: 0, sticky: false }));
  const write = (column: Column, shift: number) => {
    if (shift === column.shift) return;
    column.shift = shift;
    if (shift === 0) column.element.style.removeProperty(SHIFT);
    else column.element.style.setProperty(SHIFT, `${shift}px`);
  };
  const measure = (column: Column) => {
    const style = view.getComputedStyle(column.element);
    column.sticky = style.position === "sticky";
    // The resolved top includes the current shift; the offset is the theme's own.
    column.offset = (Number.parseFloat(style.top) || 0) - column.shift;
    column.height = column.element.getBoundingClientRect().height;
    if (!column.sticky) write(column, 0);
    else write(column, nextStickyShift(column, 0, view.innerHeight));
  };
  let lastY = view.scrollY;
  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      const delta = view.scrollY - lastY;
      lastY = view.scrollY;
      for (const column of columns) {
        if (column.sticky) write(column, nextStickyShift(column, delta, view.innerHeight));
      }
    });
  };
  const remeasure = () => columns.forEach(measure);
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(remeasure);
  columns.forEach((column) => {
    measure(column);
    resize?.observe(column.element);
  });
  view.addEventListener("scroll", onScroll, { passive: true });
  view.addEventListener("resize", remeasure, { passive: true });
  return () => {
    if (frame) view.cancelAnimationFrame(frame);
    resize?.disconnect();
    view.removeEventListener("scroll", onScroll);
    view.removeEventListener("resize", remeasure);
    columns.forEach((column) => write(column, 0));
  };
}
