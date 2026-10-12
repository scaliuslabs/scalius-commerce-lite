// Core embeds in app markup (docs/STOREFRONT-COMPONENTS.md "Core embeds"):
// elements an app component places for the store to render its own surface
// there, with its own data, rules and words. Today: `<scalius-checkout
// data-product="<handle>" data-max-quantity data-submit-label>`, the store's
// order form for a landing page. The markup around an embed is the app's;
// the embed is the store's. A component holds at most `EMBEDS_MAX` embeds;
// any beyond render nothing.

export const EMBEDS_MAX = 2;

export type MarkupPart =
  | { kind: "html"; html: string }
  | { kind: "checkout"; slug: string; maxQuantity: number; submitLabel: string | null };

const EMBED = /<scalius-checkout\b([^>]*)>[\s\S]*?<\/scalius-checkout>/g;
const ATTRIBUTE = /([a-z-]+)="([^"]*)"/g;
const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,199}$/u;

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** The checked markup cut at its core embeds (one part when it has none). */
export function splitCoreEmbeds(html: string): MarkupPart[] {
  if (!html.includes("<scalius-checkout")) return [{ kind: "html", html }];
  const parts: MarkupPart[] = [];
  let last = 0;
  let embeds = 0;
  for (const match of html.matchAll(EMBED)) {
    parts.push({ kind: "html", html: html.slice(last, match.index) });
    last = match.index + match[0].length;
    const attributes = new Map([...match[1]!.matchAll(ATTRIBUTE)].map(([, name, value]) => [name!, decode(value!)]));
    const slug = attributes.get("data-product")?.trim() ?? "";
    if (embeds >= EMBEDS_MAX || !SLUG.test(slug)) continue;
    embeds += 1;
    const max = Number(attributes.get("data-max-quantity") ?? "5");
    parts.push({
      kind: "checkout",
      slug,
      maxQuantity: Number.isInteger(max) && max >= 1 ? Math.min(max, 10) : 5,
      submitLabel: attributes.get("data-submit-label")?.trim().slice(0, 60) || null,
    });
  }
  parts.push({ kind: "html", html: html.slice(last) });
  return parts.filter((part) => part.kind !== "html" || part.html !== "");
}
