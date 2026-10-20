// Core embeds in app markup (`<scalius-embed kind="…">`, storefront-protocol.ts):
// where a component's checked markup hands a spot back to the store. The
// storefront cuts the markup at its embeds and renders each one; the SDK's
// test helpers and the packer read the same cut to hold a skin to its
// target's rule (a product-main skin places exactly one buy form). Zod-free
// and dependency-free: it runs in the storefront and in app tests.

import {
  STOREFRONT_EMBED_KINDS,
  type StorefrontEmbedKind,
  type StorefrontEmbedRule,
} from "./storefront-protocol";

export type StorefrontMarkupPart =
  | { kind: "html"; html: string }
  | {
    kind: "embed";
    embed: StorefrontEmbedKind;
    /** Its `data-*` attributes, decoded, without the `data-` prefix (`data-max-quantity` is `max-quantity`). */
    data: Record<string, string>;
    /** Its place among the markup's embeds (stable ids for repeated embeds). */
    index: number;
  };

export interface StorefrontEmbedSplit {
  parts: StorefrontMarkupPart[];
  /** Required kinds the markup does not place: the host draws the core unit instead. */
  missing: StorefrontEmbedKind[];
  /** Embeds left out: a kind the rule does not allow, or one beyond its count. */
  dropped: number;
}

const EMBED = /<scalius-embed\b([^>]*)>[\s\S]*?<\/scalius-embed>/g;
const ATTRIBUTE = /([a-z][a-z0-9-]*)="([^"]*)"/g;
const KINDS = new Set<string>(STOREFRONT_EMBED_KINDS);

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&nbsp;/g, "\u00a0").replace(/&amp;/g, "&");
}

/**
 * The checked markup cut at its embeds, under one render's rule: each
 * allowed kind up to its count (any other embed is dropped), the rule's
 * appended kinds added at the end when the markup leaves them out, and the
 * required kinds it is missing.
 */
export function splitStorefrontEmbeds(html: string, rule: StorefrontEmbedRule): StorefrontEmbedSplit {
  const parts: StorefrontMarkupPart[] = [];
  const counts = new Map<StorefrontEmbedKind, number>();
  const slots = new Set<string>();
  let dropped = 0;
  let index = 0;
  let last = 0;
  if (html.includes("<scalius-embed")) {
    for (const match of html.matchAll(EMBED)) {
      parts.push({ kind: "html", html: html.slice(last, match.index) });
      last = match.index + match[0].length;
      const attributes = new Map([...match[1]!.matchAll(ATTRIBUTE)].map(([, name, value]) => [name!, decode(value!)]));
      const kind = attributes.get("kind") ?? "";
      const allowed = KINDS.has(kind) ? rule.allowed[kind as StorefrontEmbedKind] ?? 0 : 0;
      const used = counts.get(kind as StorefrontEmbedKind) ?? 0;
      // A slot embed names one of the unit's slots, each placed once.
      const slot = kind === "slot" ? attributes.get("data-name") ?? "" : null;
      if (used >= allowed || (slot !== null && (!(rule.slots ?? []).some((name) => name === slot) || slots.has(slot)))) {
        dropped += 1;
        continue;
      }
      if (slot !== null) slots.add(slot);
      counts.set(kind as StorefrontEmbedKind, used + 1);
      const data: Record<string, string> = {};
      for (const [name, value] of attributes) if (name.startsWith("data-")) data[name.slice(5)] = value;
      parts.push({ kind: "embed", embed: kind as StorefrontEmbedKind, data, index: index++ });
    }
  }
  parts.push({ kind: "html", html: html.slice(last) });
  for (const kind of rule.appended) {
    if (!counts.has(kind)) parts.push({ kind: "embed", embed: kind, data: {}, index: index++ });
  }
  return {
    parts: parts.filter((part) => part.kind !== "html" || part.html !== ""),
    missing: rule.required.filter((kind) => !counts.has(kind)),
    dropped,
  };
}
