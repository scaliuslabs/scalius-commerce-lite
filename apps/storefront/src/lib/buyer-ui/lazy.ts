import { loadLazyScript } from "@/scripts/lazy-script";
import type { BuyerUiOptions } from "./index";

/**
 * Draws the store apps' buyer UI blocks (`renderBuyerUi`), loading the
 * renderer and its block schema (zod) only once there is a block to draw or
 * a drawn one to clear. The cart page, the payment step, the cart drawer and
 * the order page call this, never the renderer itself, so a store without
 * app blocks never downloads it (the buyer-page budget,
 * `scripts/client-chunk-graph.mjs`, holds every buyer page to that). The
 * newest call for a root wins, whatever order the renderer arrives in.
 */
export function renderBuyerUiWhenNeeded(value: unknown, options: BuyerUiOptions = {}): Promise<void> {
  const root = options.root ?? document;
  const ticket = (latest.get(root) ?? 0) + 1;
  latest.set(root, ticket);
  const blocks = Array.isArray(value) ? value : [];
  if (blocks.length === 0 && !hasDrawnBlocks(root)) return Promise.resolve();
  // Without its file the page shows no app blocks; the next render tries again.
  return track(loadLazyScript(() => import("./index")).then(({ renderBuyerUi }) => {
    if (latest.get(root) === ticket) renderBuyerUi(value, options);
  }, () => undefined));
}

const latest = new WeakMap<ParentNode, number>();
const pending = new Set<Promise<void>>();

function track(render: Promise<void>): Promise<void> {
  pending.add(render);
  void render.finally(() => pending.delete(render));
  return render;
}

/**
 * Whether app blocks are still on their way to the page: a form that checks
 * their required answers waits for them (`buyerUiDrawn`) before it submits,
 * so an order never leaves without a field the buyer had not yet seen.
 */
export function buyerUiPending(): boolean {
  return pending.size > 0;
}

/** Resolves once every render started so far has drawn (or its file could not load). */
export async function buyerUiDrawn(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

function hasDrawnBlocks(root: ParentNode): boolean {
  if (root instanceof Element && root.matches("[data-buyer-ui-target]") && root.childElementCount > 0) return true;
  for (const mount of root.querySelectorAll("[data-buyer-ui-target]")) {
    if (mount.childElementCount > 0) return true;
  }
  return false;
}

/**
 * Draws the blocks a page rendered into its carriers (`data-buyer-ui`,
 * `enhanceBuyerUi`), loading the renderer only when a carrier holds one;
 * empty carriers are just cleared of their attribute.
 */
export function enhanceBuyerUiWhenNeeded(root: ParentNode = document): Promise<void> {
  const carriers = [...root.querySelectorAll<HTMLElement>("[data-buyer-ui]")];
  if (carriers.every((carrier) => isEmptyCarrier(carrier.dataset.buyerUi))) {
    for (const carrier of carriers) delete carrier.dataset.buyerUi;
    return Promise.resolve();
  }
  return track(loadLazyScript(() => import("./index")).then(({ enhanceBuyerUi }) => enhanceBuyerUi(root), () => undefined));
}

function isEmptyCarrier(value: string | undefined): boolean {
  return value === undefined || value.trim() === "" || value.trim() === "[]";
}
