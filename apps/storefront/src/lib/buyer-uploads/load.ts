// The upload control's behaviour loads only where a file input is drawn: this
// check is all a page without one pays for. The behaviour itself
// (control.ts) is its own chunk, fetched with a dynamic import.
import { loadLazyScript } from "@/scripts/lazy-script";

export const BUYER_UPLOAD_SELECTOR = "[data-buyer-upload]";

function hasUploadControl(root: ParentNode): boolean {
  return (root instanceof Element && root.matches(BUYER_UPLOAD_SELECTOR)) || root.querySelector(BUYER_UPLOAD_SELECTOR) !== null;
}

/** Enhances the file inputs under `root` (and `root` itself); resolves at once when there are none. */
export async function loadBuyerUploads(root: ParentNode = document): Promise<void> {
  if (!hasUploadControl(root)) return;
  const { enhanceBuyerUploads } = await loadLazyScript(() => import("./control"));
  enhanceBuyerUploads(root);
}
