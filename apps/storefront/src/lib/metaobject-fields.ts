/**
 * How a Metaobjects section shows one entry field: its stored canonical text
 * (`@scalius/shared/custom-fields`) read by the field's type into parts the
 * section draws (text, a link, a colour swatch, a photo). Nothing here makes
 * markup, so every value reaches the page as escaped text or a checked
 * attribute. Product, variant, collection and JSON fields are not shown
 * (v1): they have no buyer-facing form without more reads.
 */
import { fromMinor } from "@scalius/shared/money";
import { formatMoney, getDecimalPlaces } from "@/lib/currency";
import type { HomepageMediaAsset, HomepageMetaobjectField } from "@/lib/api/storefront";
import type { NewsletterLanguage } from "@/lib/newsletter-copy";

/** One drawn piece of a field value (a list field has several). */
export type MetaobjectPart =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; label: string; external: boolean }
  | { kind: "color"; value: string }
  | { kind: "image"; asset: HomepageMediaAsset };

/** A field ready to draw: its name and the parts of its value, or null when it has nothing to show. */
export interface MetaobjectFieldView {
  key: string;
  name: string;
  parts: MetaobjectPart[];
  /** A list value: the parts are separated by commas (photos sit side by side). */
  list: boolean;
}

export interface MetaobjectFieldContext {
  media: ReadonlyMap<string, HomepageMediaAsset>;
  currencySymbol: string;
  currencyCode: string;
  language: NewsletterLanguage;
}

const WORDS: Record<NewsletterLanguage, { yes: string; no: string; locale: string }> = {
  en: { yes: "Yes", no: "No", locale: "en-GB" },
  bn: { yes: "হ্যাঁ", no: "না", locale: "bn-BD" },
};

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Types this version of the storefront does not draw (no buyer-facing form without more reads). */
const HIDDEN_ITEM_TYPES = new Set(["json", "product_reference", "variant_reference", "collection_reference"]);

/** The type of one item: `list.money` and `money` both read `money`. */
function itemType(type: string): string {
  return type.startsWith("list.") ? type.slice(5) : type;
}

/**
 * A link target the section may draw: an https address or a store path.
 * Everything else (`javascript:`, `http:`, `data:`, `//host`) is shown as
 * plain text instead of a link.
 */
export function metaobjectLink(value: string): { href: string; external: boolean } | null {
  const text = value.trim();
  if (text.startsWith("/")) return text.startsWith("//") || /[\s\\]/.test(text) ? null : { href: text, external: false };
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? { href: url.href, external: true } : null;
  } catch {
    return null;
  }
}

function linkLabel(value: string, href: string, external: boolean): string {
  if (!external) return value.trim();
  const url = new URL(href);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.hostname}${path}`;
}

function formatDate(value: string, language: NewsletterLanguage, withTime: boolean): string | null {
  const time = Date.parse(withTime ? value : `${value}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  // The instant is shown in UTC: a date has no zone, and a date and time names the zone it is in.
  try {
    const text = new Intl.DateTimeFormat(WORDS[language].locale, withTime
      ? { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }
      : { dateStyle: "long", timeZone: "UTC" }).format(new Date(time));
    return withTime ? `${text} UTC` : text;
  } catch {
    return null;
  }
}

function itemPart(type: string, value: string, context: MetaobjectFieldContext): MetaobjectPart | null {
  switch (type) {
    case "single_line_text":
    case "multi_line_text":
    case "integer":
    case "decimal":
      return value.trim() ? { kind: "text", text: value } : null;
    case "boolean":
      return { kind: "text", text: value === "true" ? WORDS[context.language].yes : WORDS[context.language].no };
    case "date":
    case "date_time": {
      const text = formatDate(value, context.language, type === "date_time");
      return text ? { kind: "text", text } : null;
    }
    case "url": {
      const link = metaobjectLink(value);
      return link ? { kind: "link", href: link.href, label: linkLabel(value, link.href, link.external), external: link.external } : value.trim() ? { kind: "text", text: value } : null;
    }
    case "color":
      return COLOR.test(value) ? { kind: "color", value: value.toLowerCase() } : null;
    case "money": {
      const minor = Number(value);
      if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(minor)) return null;
      const amount = fromMinor(minor, getDecimalPlaces(context.currencyCode));
      return { kind: "text", text: formatMoney(amount, { symbol: context.currencySymbol, code: context.currencyCode }) };
    }
    case "media_reference": {
      const asset = context.media.get(value);
      return asset ? { kind: "image", asset } : null;
    }
    default:
      return null;
  }
}

function listItems(value: string): string[] {
  try {
    const items = JSON.parse(value) as unknown;
    return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** One field as the section draws it, or null (a hidden type, an empty value, a photo that did not load). */
export function metaobjectFieldView(field: HomepageMetaobjectField, context: MetaobjectFieldContext): MetaobjectFieldView | null {
  const type = itemType(field.type);
  if (HIDDEN_ITEM_TYPES.has(type) || !field.value) return null;
  const list = field.type.startsWith("list.");
  const values = list ? listItems(field.value) : [field.value];
  const parts = values.flatMap((value) => {
    const part = itemPart(type, value, context);
    return part ? [part] : [];
  });
  return parts.length > 0 ? { key: field.key, name: field.name, parts, list } : null;
}

/** An entry's visible fields, in the definition's order. */
export function metaobjectFieldViews(fields: readonly HomepageMetaobjectField[], context: MetaobjectFieldContext): MetaobjectFieldView[] {
  return fields.flatMap((field) => {
    const view = metaobjectFieldView(field, context);
    return view ? [view] : [];
  });
}

/** Whether every part of a field is a photo (drawn side by side, not as a text run). */
export function metaobjectFieldIsPhotos(view: MetaobjectFieldView): boolean {
  return view.parts.every((part) => part.kind === "image");
}
