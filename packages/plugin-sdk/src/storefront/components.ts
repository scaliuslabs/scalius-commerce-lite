// Building blocks for storefront components: images with their renditions,
// prices, islands, core behaviours (quick add, the cart drawer, the cart
// count) and editable text. Each is markup only; the storefront's own client
// runtime gives the data attributes their behaviour.

import type {
  StorefrontImage,
  StorefrontIslandHydration,
  StorefrontMoney,
  StorefrontProductCard,
  StorefrontRenderContext,
} from "@scalius/shared/plugins/storefront-protocol";
import { EMPTY_HTML, escapeHtml, raw, renderChild, type Html, type Renderable } from "./html";

type Attributes = Record<string, string | number | boolean | null | undefined>;

function attributes(values: Attributes): string {
  let out = "";
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === false) continue;
    out += value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`;
  }
  return out;
}

function children(content: unknown): string {
  const out: string[] = [];
  renderChild(content, out);
  return out.join("");
}

// ── Words ─────────────────────────────────────────────────────────────────

/** Picks the page language's words: `t(context, { en: "Shop now", bn: "এখনই কিনুন" })`. */
export function t(context: Pick<StorefrontRenderContext, "store">, words: { en: string; bn?: string }): string {
  return context.store.language === "bn" && words.bn ? words.bn : words.en;
}

// ── Images ────────────────────────────────────────────────────────────────

export interface ImageProps {
  image: StorefrontImage | null | undefined;
  /** The `sizes` of its `srcset` (`(min-width: 1024px) 25vw, 50vw`). */
  sizes?: string;
  /** `eager` (and `fetchpriority="high"`) for the page's largest above-the-fold image only. */
  loading?: "lazy" | "eager";
  class?: string;
  /** Overrides the image's own alt text ("" for a decorative image). */
  alt?: string;
}

/** An `<img>` with the image's renditions and intrinsic size (no layout shift); nothing without an image. */
export function Image(props: ImageProps): Html {
  const image = props.image;
  if (!image?.url) return EMPTY_HTML;
  const eager = props.loading === "eager";
  return raw(`<img${attributes({
    src: image.url,
    srcset: image.srcset ?? undefined,
    sizes: image.srcset ? props.sizes ?? "100vw" : undefined,
    width: image.width ?? undefined,
    height: image.height ?? undefined,
    alt: props.alt ?? image.alt,
    loading: eager ? "eager" : "lazy",
    fetchpriority: eager ? "high" : undefined,
    decoding: eager ? "sync" : "async",
    class: props.class,
  })}>`);
}

/** A file the app ships in `public/` (fonts, illustrations), on the store's origin. */
export function asset(context: Pick<StorefrontRenderContext, "assets">, path: string): string {
  return `${context.assets}public/${path.replace(/^\/+/, "")}`;
}

// ── Prices ────────────────────────────────────────────────────────────────

export interface PriceProps {
  price: StorefrontMoney;
  compareAt?: StorefrontMoney | null;
  /** The price varies by option: "From …". */
  from?: boolean;
  context: Pick<StorefrontRenderContext, "store">;
  class?: string;
}

/**
 * The price, and while discounted the struck regular price after it. Screen
 * readers hear "Sale price …, Regular price …". Style it with
 * `[data-price]`, `[data-price-current]` and `[data-price-regular]`.
 */
export function Price(props: PriceProps): Html {
  const { price, compareAt, context } = props;
  const discounted = compareAt !== null && compareAt !== undefined && compareAt.amount > price.amount;
  const current = props.from ? t(context, { en: `From ${price.formatted}`, bn: `${price.formatted} থেকে` }) : price.formatted;
  const label = discounted ? t(context, { en: "Sale price", bn: "বিক্রয় মূল্য" }) : t(context, { en: "Price", bn: "মূল্য" });
  let out = `<span data-price${props.class ? ` class="${escapeHtml(props.class)}"` : ""}${discounted ? " data-discounted" : ""}>`;
  out += `<span class="sr-only">${escapeHtml(label)}</span><span data-price-current>${escapeHtml(current)}</span>`;
  if (discounted) {
    out += `<span class="sr-only">${escapeHtml(t(context, { en: "Regular price", bn: "নিয়মিত মূল্য" }))}</span>`;
    out += `<s data-price-regular>${escapeHtml(compareAt.formatted)}</s>`;
  }
  return raw(`${out}</span>`);
}

// ── Islands ───────────────────────────────────────────────────────────────

export interface IslandProps {
  /** A declared island (`storefront.islands`), built from `src/islands/<name>.ts`. */
  name: string;
  /** JSON the island's `mount` gets. Keep it small: it is in the page's HTML. */
  props?: unknown;
  /** When its code loads: `visible` (default), `idle`, `load` or `interaction` (first focus, hover or tap). */
  hydrate?: StorefrontIslandHydration;
  /** The markup shown until (and unless) the island mounts: make it useful without JavaScript. */
  children?: Renderable;
  class?: string;
}

/** Interactive markup: the server renders `children`, the island's client module takes over in the browser. */
export function Island(props: IslandProps): Html {
  const json = props.props === undefined ? undefined : JSON.stringify(props.props);
  return raw(`<scalius-island${attributes({
    "data-island": props.name,
    "data-hydrate": props.hydrate ?? "visible",
    "data-props": json,
    class: props.class,
  })}>${children(props.children)}</scalius-island>`);
}

// ── Core behaviours (no app JavaScript) ───────────────────────────────────

/**
 * Attributes of a card's add link: an `<a>` to the product that adds it to
 * the cart in place and opens the cart (simple products), else opens its page.
 *
 *   <a {...quickAdd(product)}>Add to cart</a>
 */
export function quickAdd(product: Pick<StorefrontProductCard, "url" | "quickAdd">): Attributes {
  return product.quickAdd ? { href: product.url, "data-card-quick-add": "" } : { href: product.url };
}

/** Attributes of a button that opens the cart drawer: `<button type="button" {...openCart()}>`. */
export function openCart(): Attributes {
  return { "data-cart-open": "" };
}

/** The cart's item count, kept current in the browser (empty while the cart is). */
export function CartCount(props: { class?: string }): Html {
  return raw(`<span data-scalius-cart-count${props.class ? ` class="${escapeHtml(props.class)}"` : ""} aria-live="polite"></span>`);
}

// ── Editable text ─────────────────────────────────────────────────────────

/**
 * Marks the element that shows one text setting, so the theme editor can
 * select it and edit the words in place. Only in the editor's preview: the
 * published page carries no marks.
 *
 *   <h2 {...editable(context, "heading")}>{settings.heading}</h2>
 */
export function editable(context: Pick<StorefrontRenderContext, "preview">, setting: string): Attributes {
  return context.preview ? { "data-theme-field": setting } : {};
}

// ── Core embeds ───────────────────────────────────────────────────────────

export interface CheckoutProps {
  /** The product to order: a card from a `product` or `products` setting. Nothing renders without one. */
  product: Pick<StorefrontProductCard, "url"> | null | undefined;
  /** The most the quantity picker offers (1 hides it; at most 10). */
  maxQuantity?: number;
  /** The submit button's words (the store's checkout language otherwise). */
  submitLabel?: string;
}

/**
 * The store's own order form, in place: the single-page order of a landing
 * page. The buyer picks an option and a quantity and fills in name, phone
 * and address here; the store checks it, prices delivery and places the
 * cash-on-delivery order after one confirmation. Style it through
 * `.scalius-order-form` and its parts.
 *
 *   <section id="order"><Checkout product={settings.product} maxQuantity={5} /></section>
 */
export function Checkout(props: CheckoutProps): Html {
  const url = props.product?.url ?? "";
  const slug = decodeURIComponent(url.split(/[?#]/, 1)[0]!.split("/").filter(Boolean).pop() ?? "");
  if (!slug) return EMPTY_HTML;
  return raw(`<scalius-checkout${attributes({
    "data-product": slug,
    "data-max-quantity": props.maxQuantity,
    "data-submit-label": props.submitLabel,
  })}></scalius-checkout>`);
}
