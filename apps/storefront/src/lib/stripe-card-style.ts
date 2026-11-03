/**
 * Stripe's card fields draw in their own frame, so they cannot read the
 * page's colours: they take the text and helper-text colours of the element
 * they mount in, and take them again whenever the page's colour scheme
 * changes after they mount (the device's setting, the buyer's switch, the
 * switch in another tab). Error text keeps the text colour: the page shows
 * its own error below the field.
 */

/** The window an element is in (the page's own, not a global). */
function viewOf(element: Element): Window & typeof globalThis {
  return (element.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
}

/** The style Stripe's card element takes: the page's colours where it mounts. */
export function stripeCardStyle(element: Element, fontSize: string) {
  const style = viewOf(element).getComputedStyle(element);
  const foreground = style.color;
  const placeholder = style.getPropertyValue("--muted-foreground").trim() || foreground;
  return {
    base: { fontSize, color: foreground, fontFamily: "sans-serif", iconColor: foreground, "::placeholder": { color: placeholder } },
    invalid: { color: foreground, iconColor: foreground },
  };
}

/** Restyles a mounted card when the page's colour scheme changes; returns the stop. */
export function followColorScheme(element: Element, fontSize: string, card: { update?(options: { style: ReturnType<typeof stripeCardStyle> }): void }): () => void {
  const observer = new (viewOf(element).MutationObserver)(() => card.update?.({ style: stripeCardStyle(element, fontSize) }));
  observer.observe(element.ownerDocument.documentElement, { attributes: true, attributeFilter: ["data-color-scheme"] });
  return () => observer.disconnect();
}
