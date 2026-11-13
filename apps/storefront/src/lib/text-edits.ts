/**
 * A buyer's edit to a text field, as code that reads the text should see it.
 *
 * An input method (Bangla, Chinese, Japanese) composes a word in steps, each
 * an `input` event whose text is not the buyer's yet: "ল" before "লাল". Code
 * that takes the text away (hands it to the search palette) or rewrites the
 * value (the phone field, a buyer's answer) acts on letters the buyer never
 * typed, and a field that moves focus mid-composition gets the word twice. So
 * by default the handler runs on `input` outside a composition and once on
 * `compositionend` with the composed text.
 *
 * A handler that only filters or suggests from the text (`live: true`: the
 * delivery-area list, address suggestions, a facet filter) runs on every step
 * as well: Android's Gboard composes every Latin word until a space or a
 * suggestion tap, so waiting would leave those lists stale while the buyer
 * types. Either way a browser that also sends a plain `input` after
 * `compositionend` runs the handler again with the same text, so handlers
 * must be idempotent (they read the field, never the event's data).
 */
export function onTextEdit(
  target: EventTarget,
  handler: (event: Event) => void,
  options?: AddEventListenerOptions,
  mode: { live?: boolean } = {},
): () => void {
  const input = (event: Event) => {
    if (!mode.live && (event as InputEvent).isComposing) return;
    handler(event);
  };
  target.addEventListener("input", input, options);
  target.addEventListener("compositionend", handler, options);
  return () => {
    target.removeEventListener("input", input, options);
    target.removeEventListener("compositionend", handler, options);
  };
}
