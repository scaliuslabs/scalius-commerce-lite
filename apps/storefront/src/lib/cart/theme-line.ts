/**
 * The theme's line on the cart page (`<template data-cart-line-template>`,
 * drawn by the page from the theme's arrangement): its sub-parts are
 * `<!--line:name-->` marks (`<!--line:name:variant-->` for a variant the
 * theme chose), and its root's `data-line-key` is empty. Only a page that has
 * one loads this (line-html.ts `cartLinePending`).
 */
import { detailsPart, escapeHtml, hostLineParts, lineDetails, lineRemove, type CartLineHtmlSlots, type LineFact } from "./line-html";
import { pageLanguage } from "@/lib/store-time-zone";
import { privateVariantWord } from "@/lib/private-pages/labels";
import type { CartLineView } from "./line-view";
import { withOrder } from "./line-reading-order";

/** A line's sub-parts' variants (private-anatomy.ts), by part; a part not named draws its default. */
export type CartLineVariants = Readonly<Record<string, string>>;

const chip: LineFact = (text, attribute) => `<li class="rounded-md bg-muted px-2 py-0.5 text-xs text-foreground" data-part="line-chip" ${attribute}>${text}</li>`;

/**
 * What the buyer chose, as the `details` variant draws it: `lines` (the
 * host's: each fact on its own line, undefined here), `values` (the option
 * values only, " / ", on one line where they fit and wrapped where not: never
 * cut, so a phone still shows what tells two lines of one product apart) or
 * `chips` (each fact a chip). The answers to the store's inputs stay rows in
 * every variant: their controls replace them by key.
 */
function detailsHtml(view: CartLineView, slots: CartLineHtmlSlots, variant: string | undefined): string | undefined {
  if (variant === "values") {
    const [, purchaseOptions, properties, fulfilment] = lineDetails(view, slots);
    const values = view.options.map((each) => escapeHtml(each.label)).join(" / ");
    return (values && `<span class="block break-words" data-cart-line-options>${values}</span>`) + purchaseOptions + properties + fulfilment;
  }
  if (variant !== "chips") return undefined;
  const [options, purchaseOptions, properties, fulfilment] = lineDetails(view, slots, chip);
  const list = options + purchaseOptions + fulfilment;
  return (list ? `<ul class="mt-1 flex flex-wrap gap-1.5">${list}</ul>` : "") + properties;
}

/** A line's sub-parts by their anatomy names (private-anatomy.ts), each "" when the line has none, each in its variant. */
export function cartLineParts(view: CartLineView, slots: CartLineHtmlSlots, variants: CartLineVariants = {}): Record<string, string> {
  const parts = hostLineParts(view, slots);
  const details = detailsHtml(view, slots, variants.details);
  if (details !== undefined) parts.details = detailsPart(details);
  // `words`: the word on a 44px target at every width, named as the icon is (the word is in its name).
  if (variants.remove === "words") {
    parts.remove = lineRemove(slots, "inline-flex min-h-11 min-w-11 px-2 text-sm font-medium", escapeHtml(privateVariantWord("remove", pageLanguage())));
  }
  return parts;
}

/** The theme's line filled in: each mark replaced by its sub-part, in the variant the mark names (drawn again for it). */
export function cartLineFromTemplate(template: string, view: CartLineView, slots: CartLineHtmlSlots): string {
  const parts = hostLineParts(view, slots);
  // Functions, never replacement strings: a line key's `$&` or `$'` is text, not a pattern.
  return template
    .replace('data-line-key=""', () => `data-line-key="${escapeHtml(view.key)}"`)
    // `@<order>`: the part's place on screen where the markup reads the title first (line-reading-order.ts).
    .replace(/<!--line:([a-z-]+)(?::([a-z-]+))?(?:@(\d+))?-->/g, (_mark, name: string, variant?: string, order?: string) =>
      withOrder((variant ? cartLineParts(view, slots, { [name]: variant }) : parts)[name] ?? "", order === undefined ? undefined : Number(order)));
}
