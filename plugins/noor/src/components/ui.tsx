// Noor's building blocks: the section shell every section draws in (its
// background tone and spacing), the section head, buttons, stars and the
// product card every grid, rail and the card slot share. All styling is in
// storefront.css (`noor-` classes) on the store's own tokens, so the
// merchant's colours, fonts, radius, density and container width apply.

import {
  Image,
  Island,
  Price,
  Slot,
  editable,
  formatNumber,
  plural,
  quickAdd,
  t,
  type Renderable,
  type StorefrontProductCard,
  type StorefrontRenderContext,
} from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";

export type Context = StorefrontRenderContext;

/** Classes from parts, falsy parts dropped. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** A setting's text, or null when it is unset or blank. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** One of `allowed`, else `fallback` (a select value from an older version of the schema). */
export function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export const TONES = ["plain", "soft", "ink", "accent"] as const;
export const SPACES = ["none", "s", "m", "l"] as const;

/**
 * A section's shell: its background tone (the page, a soft panel, the ink
 * colour or the brand colour) and its vertical spacing, from the density's
 * section gap so Noor's sections sit in the same rhythm as the store's own.
 * `bleed` sections draw edge to edge; the rest sit in the store's container.
 */
export function Section({ name, tone, space, bleed = false, label, children, id }: {
  name: string;
  tone?: unknown;
  space?: unknown;
  bleed?: boolean;
  label?: string | null;
  id?: string;
  children: Renderable;
}) {
  return (
    <section
      class={cx("noor-s", `noor-s-${name}`)}
      data-tone={choice(tone, TONES, "plain")}
      data-space={choice(space, SPACES, "m")}
      aria-label={label ?? undefined}
      id={id}
    >
      {bleed ? children : <div class="noor-wrap">{children}</div>}
    </section>
  );
}

export function SectionHead({ eyebrow, heading, body, link, linkLabel, align = "start", level = 2, context, children }: {
  eyebrow?: string | null;
  heading?: string | null;
  body?: string | null;
  link?: string | null;
  linkLabel?: string | null;
  align?: "start" | "center";
  level?: 1 | 2;
  context: Context;
  children?: Renderable;
}) {
  if (!eyebrow && !heading && !body && !(link && linkLabel) && !children) return null;
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <header class={cx("noor-head", align === "center" && "is-center")}>
      <div class="noor-head-copy">
        {eyebrow ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{eyebrow}</p> : null}
        {heading ? <Heading class="noor-h2" {...editable(context, "heading")}>{heading}</Heading> : null}
        {body ? <p class="noor-lede" {...editable(context, "text")}>{body}</p> : null}
      </div>
      {children || (link && linkLabel) ? (
        <div class="noor-head-side">
          {children}
          {link && linkLabel ? (
            <a class="noor-more" href={link}>
              <span {...editable(context, "link_label")}>{linkLabel}</span>
              <Icon name="arrow" size={16} />
            </a>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

export function Button({ href, children, variant = "solid", size, editableKey, context, icon, attrs = {} }: {
  href: string;
  children: Renderable;
  /** solid: the brand colour; ink: the text colour; outline; light: white on photos. */
  variant?: "solid" | "ink" | "outline" | "light";
  size?: "small" | "large";
  editableKey?: string;
  context: Context;
  icon?: boolean;
  attrs?: Record<string, string>;
}) {
  return (
    <a class={cx("noor-btn", `is-${variant}`, size && `is-${size}`)} href={href} {...attrs}>
      <span {...(editableKey ? editable(context, editableKey) : {})}>{children}</span>
      {icon ? <Icon name="arrow" size={16} /> : null}
    </a>
  );
}

export function Stars({ value, label }: { value: number; label: string }) {
  const full = Math.round(Math.max(0, Math.min(5, value)));
  return (
    <span class="noor-stars" role="img" aria-label={label}>
      {[0, 1, 2, 3, 4].map((index) => <span class={index < full ? "is-on" : undefined} aria-hidden="true">★</span>)}
    </span>
  );
}

/** A rating as the store writes numbers ("4.6", "৪.৬"). */
export function ratingValue(context: Context, average: number): string {
  return formatNumber(context, average, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** "1 review", "12 reviews", "১২টি রিভিউ". */
export function reviewCount(context: Context, count: number): string {
  return plural(context, count, { en: { one: "# review", other: "# reviews" }, bn: { other: "#টি রিভিউ" } });
}

/** A sale badge's percentage ("20%", "২০%"). */
export function percent(context: Context, value: number): string {
  return formatNumber(context, value / 100, { style: "percent" });
}

export function ratingLabel(context: Context, average: number, count?: number): string {
  const value = ratingValue(context, average);
  const five = formatNumber(context, 5);
  return count === undefined
    ? t(context, { en: `Rated ${value} out of ${five}`, bn: `${five}-এর মধ্যে ${value}` })
    : t(context, { en: `Rated ${value} out of ${five} from ${reviewCount(context, count)}`, bn: `${reviewCount(context, count)}তে ${five}-এর মধ্যে ${value}` });
}

export interface CardOptions {
  ratio?: string;
  align?: string;
  action?: string;
  showRating?: boolean;
  showHover?: boolean;
  /** The photo shows before the first scroll: load it eagerly. */
  eager?: boolean;
  /** An eager photo that is not one of the likely largest: eager at normal priority. */
  normalPriority?: boolean;
  sizes?: string;
  /**
   * The card is the store's product card (Noor's card skin): it places the
   * card slots, where other apps add badges and a line under the price.
   */
  slots?: boolean;
}

/**
 * The Noor card: a quiet photo (the second photo fades in on hover), small
 * badges, the name, the price and the rating. Simple products add to the
 * cart in place; others open their page.
 */
export function ProductCard({ product, context, options = {} }: { product: StorefrontProductCard; context: Context; options?: CardOptions }) {
  const ratio = choice(options.ratio, ["portrait", "tall", "square"] as const, "portrait");
  const action = choice(options.action, ["bar", "icon", "button", "none"] as const, "bar");
  const hover = options.showHover !== false && product.hoverImage;
  const sizes = options.sizes ?? "(min-width: 1280px) 300px, (min-width: 768px) 30vw, 48vw";
  const addWords = product.quickAdd
    ? t(context, { en: "Add to cart", bn: "কার্টে যোগ করুন" })
    : t(context, { en: "Choose options", bn: "অপশন বাছুন" });
  const addLabel = product.quickAdd
    ? t(context, { en: `Add ${product.title} to cart`, bn: `${product.title} কার্টে যোগ করুন` })
    : t(context, { en: `Choose options for ${product.title}`, bn: `${product.title}: অপশন বাছুন` });
  const canAdd = !product.soldOut && action !== "none";
  return (
    <article class={cx("noor-card", `ratio-${ratio}`, options.align === "center" && "is-center", product.soldOut && "is-sold-out", hover && "has-hover")}>
      <div class="noor-card-media">
        <a href={product.url} tabindex="-1" aria-hidden="true" class="noor-card-photo">
          {product.image
            ? <Image image={product.image} sizes={sizes} loading={options.eager ? "eager" : "lazy"} fetchpriority={options.eager && options.normalPriority ? "auto" : undefined} alt="" class="noor-card-img" />
            : <span class="noor-card-blank" />}
          {hover ? <Image image={product.hoverImage} sizes={sizes} alt="" class="noor-card-img is-alt" /> : null}
        </a>
        {product.soldOut
          ? <span class="noor-badge is-muted">{t(context, { en: "Sold out", bn: "স্টক শেষ" })}</span>
          : product.percentOff ? <span class="noor-badge is-sale">−{percent(context, product.percentOff)}</span> : null}
        {options.slots ? <div class="noor-card-apps"><Slot name="product_card.badges" /></div> : null}
        {canAdd && action === "bar" ? (
          <a class="noor-card-bar" {...quickAdd(product)} aria-label={addLabel}>
            <Icon name={product.quickAdd ? "plus" : "arrow"} size={16} /><span>{addWords}</span>
          </a>
        ) : null}
        {canAdd && action === "icon" ? (
          <a class="noor-card-icon" {...quickAdd(product)} aria-label={addLabel} title={addLabel}>
            <Icon name={product.quickAdd ? "plus" : "arrow"} size={18} />
          </a>
        ) : null}
      </div>
      <div class="noor-card-body">
        <h3 class="noor-card-title"><a href={product.url}>{product.title}</a></h3>
        <div class="noor-card-meta">
          <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price" />
          {options.showRating !== false && product.rating ? (
            <span class="noor-card-rating" role="img" aria-label={ratingLabel(context, product.rating.average, product.rating.count)}>
              <span aria-hidden="true">★ {ratingValue(context, product.rating.average)}</span>
            </span>
          ) : null}
        </div>
        {product.facts[0] ? <p class="noor-card-fact">{product.facts[0]}</p> : null}
        {options.slots ? <Slot name="product_card.meta" /> : null}
        {canAdd && action === "button" ? (
          <a class="noor-btn is-outline is-small noor-card-button" {...quickAdd(product)} aria-label={addLabel}>{addWords}</a>
        ) : null}
      </div>
    </article>
  );
}

/** Cards of an eager first row that load at high priority: a phone's first row. */
const EAGER_HIGH_PRIORITY_CARDS = 2;

/** Product cards in a grid (wrapping) or a row (scrolling, snapping; arrows on computers). */
export function Products({ products, context, layout = "grid", columns = 4, card, label }: {
  products: StorefrontProductCard[];
  context: Context;
  layout?: string;
  columns?: number;
  card?: CardOptions;
  label?: string | null;
}) {
  const cols = Math.max(2, Math.min(6, Math.round(columns)));
  // A list that shows before the first scroll loads its first row eagerly; a
  // phone's first row (two cards, either of which may be the largest photo)
  // keeps high priority, the rest of the row loads at normal priority.
  const cards = products.map((product, index) => (
    <li class="noor-products-item" data-slide><ProductCard product={product} context={context} options={{
      ...card,
      eager: card?.eager === true && index < cols,
      normalPriority: index >= EAGER_HIGH_PRIORITY_CARDS,
    }} /></li>
  ));
  if (layout !== "row") return <ul class="noor-products is-grid" style={{ "--noor-cols": cols }}>{cards}</ul>;
  return (
    <Rail label={label ?? t(context, { en: "Products", bn: "পণ্য" })} context={context} cols={cols}>
      <ul class="noor-products is-row" data-track tabindex="0">{cards}</ul>
    </Rail>
  );
}

/** A scrolling row with previous and next buttons on computers (the `rail` island). */
export function Rail({ children, label, context, cols }: { children: Renderable; label: string; context: Context; cols?: number }) {
  return (
    <Island name="rail" hydrate="visible" class="noor-rail-island">
      <div class="noor-rail" role="region" aria-label={label} style={cols ? { "--noor-cols": cols } : undefined}>
        {children}
        <div class="noor-rail-nav" data-rail-nav hidden>
          <button type="button" class="noor-round" data-prev aria-label={t(context, { en: "Previous", bn: "আগের" })}><Icon name="back" size={18} /></button>
          <button type="button" class="noor-round" data-next aria-label={t(context, { en: "Next", bn: "পরের" })}><Icon name="arrow" size={18} /></button>
        </div>
      </div>
    </Island>
  );
}
