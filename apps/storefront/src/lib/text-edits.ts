/**
 * A buyer's edit to a text field, as code that reads the text should see it.
 *
 * An input method (Bangla, Chinese, Japanese, a phone's predictive keyboard)
 * composes a word in steps, each an `input` event whose text is not the
 * buyer's yet: "ল" before "লাল". Code that acts on each step (hands the text
 * to the search palette, searches, suggests an address, rewrites the value)
 * acts on letters the buyer never typed, and a field that moves focus
 * mid-composition gets the word twice. So the handler runs on `input` outside
 * a composition and once on `compositionend` with the composed text; a
 * browser that also sends a plain `input` after `compositionend` runs it
 * again with the same text, so handlers must be idempotent (they read the
 * field, never the event's data).
 */
export function onTextEdit(
  target: EventTarget,
  handler: (event: Event) => void,
  options?: AddEventListenerOptions,
): () => void {
  const input = (event: Event) => {
    if ((event as InputEvent).isComposing) return;
    handler(event);
  };
  target.addEventListener("input", input, options);
  target.addEventListener("compositionend", handler, options);
  return () => {
    target.removeEventListener("input", input, options);
    target.removeEventListener("compositionend", handler, options);
  };
}
