/**
 * The accessible name of a control whose visible words are generic ("Add to
 * cart", "View all") and need the thing they act on: "Add to cart: Linen
 * shirt". Put it in `aria-label`, never as a visually hidden `: name` span
 * after the visible words: an off-screen span is a block of its own, so
 * browsers named the control "Add to cart : Linen shirt". The visible words
 * stay its start (WCAG 2.5.3, label in name).
 */
export function namedActionLabel(action: string, name: string): string {
  return `${action.trim()}: ${name.trim()}`;
}
