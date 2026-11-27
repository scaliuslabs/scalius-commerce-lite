/**
 * The cart page's first showing of a cart with lines, and the apps' blocks that land after it (the cart check's
 * answer). A block that lands after the lines show moves what is under it (a layout shift), so:
 *
 * - only where the store has an active app that draws a line's or the summary's block (`CART_REVEAL_SLOTS`, named
 *   by the layout's `buyerUiSlots` on the page root's `data-app-blocks`) may the first showing wait, at most
 *   `FIRST_REVEAL_WAIT_MS`, for the check's blocks; a store with no such app never waits;
 * - each block's height in the cart and its form (`CART_RESERVED_SLOTS`) is remembered with the stored cart
 *   (`CART_BLOCK_HEIGHTS_KEY`), and a later view reserves it before the lines show: when every waited block's room
 *   is known, the first showing does not wait at all. A first view of a block in the form (drawn at once beside the
 *   lines on a wide page) still moves what is under it when the block lands.
 */

/** The cart column's app slots whose blocks land with the cart check and hold the first showing: a line's and the summary's. */
export const CART_REVEAL_SLOTS = ["cart.line.after", "cart.page.summary"] as const;

/** Every app slot of the cart page whose block lands after the first paint: its room is remembered and reserved. */
export const CART_RESERVED_SLOTS = [...CART_REVEAL_SLOTS, "cart.page.below", "checkout.contact.after", "checkout.delivery.after"] as const;

/** The longest the first showing waits for the check's blocks; a slower check never holds the lines. */
export const FIRST_REVEAL_WAIT_MS = 500;

/** Beside the stored cart (`cart:v3`): each block's last drawn height, by slot and, for a line's, its line key. */
export const CART_BLOCK_HEIGHTS_KEY = "cart:v3:block-heights";

const slotsOf = (root: HTMLElement | null) => (root?.dataset.appBlocks ?? "").split(" ");

/** Whether this page's store draws a line's or the summary's app block (the page root's `data-app-blocks`): the first showing may wait. */
export function cartColumnHasAppBlocks(root: HTMLElement | null): boolean {
  return CART_REVEAL_SLOTS.some((slot) => slotsOf(root).includes(slot));
}

/** Whether this page's store draws any app block whose room the page remembers. */
export function cartHasReservedBlocks(root: HTMLElement | null): boolean {
  return CART_RESERVED_SLOTS.some((slot) => slotsOf(root).includes(slot));
}

function mounts(root: ParentNode, slots: readonly string[] = CART_RESERVED_SLOTS): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-buyer-ui-target]")]
    .filter((mount) => slots.includes(mount.dataset.buyerUiTarget ?? ""));
}

const keyOf = (mount: HTMLElement) => mount.dataset.buyerUiLine ? `${mount.dataset.buyerUiTarget}|${mount.dataset.buyerUiLine}` : mount.dataset.buyerUiTarget!;

function readHeights(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(CART_BLOCK_HEIGHTS_KEY) ?? "null") as unknown;
    return value && typeof value === "object" ? value as Record<string, number> : {};
  } catch {
    return {};
  }
}

/** Whether the remembered rooms hold until the check's blocks are drawn (lines drawn again meanwhile take them too). */
let reserving = false;

/**
 * Reserves each block's last known room before the lines show (a mount with none known keeps what it has); true when
 * every mount's room is known, so the lines can show at once.
 */
export function reserveKnownBlockHeights(root: ParentNode): boolean {
  reserving = true;
  const heights = readHeights();
  let known = true;
  for (const mount of mounts(root)) {
    const height = heights[keyOf(mount)];
    if (typeof height !== "number" || !Number.isFinite(height) || height < 0) {
      if ((CART_REVEAL_SLOTS as readonly string[]).includes(mount.dataset.buyerUiTarget ?? "")) known = false;
      continue;
    }
    if (height === 0) continue;
    mount.hidden = false;
    mount.style.minHeight = `${Math.min(height, 4000)}px`;
    mount.dataset.blockReserved = "";
  }
  return known;
}

/** Lines drawn again before the check's blocks land (the check's answer redraws them) keep their reserved room. */
export function keepReservedBlockHeights(root: ParentNode): void {
  if (reserving) reserveKnownBlockHeights(root);
}

/** Once the blocks are drawn: the reserved room goes, and each block's height is remembered for the next view. */
export function settleBlockHeights(root: ParentNode): void {
  reserving = false;
  const heights: Record<string, number> = {};
  for (const mount of mounts(root)) {
    if (mount.dataset.blockReserved !== undefined) {
      mount.style.minHeight = "";
      delete mount.dataset.blockReserved;
      if (mount.childElementCount === 0) mount.hidden = true;
    }
    heights[keyOf(mount)] = mount.hidden || mount.childElementCount === 0 ? 0 : Math.round(mount.getBoundingClientRect().height);
  }
  try {
    localStorage.setItem(CART_BLOCK_HEIGHTS_KEY, JSON.stringify(heights));
  } catch {
    // Storage full or refused: the next view waits a moment again.
  }
}
