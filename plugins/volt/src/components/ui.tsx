// Volt's building blocks: setting readers, the section shell and head, the
// discount pill and the product card every grid, row, tab and listing
// shares. Styling is storefront.css (`volt-` classes) on the store's tokens.

import {
  Image,
  formatMoney,
  quickAdd,
  t,
  type Renderable,
  type StorefrontProductCard,
  type StorefrontRenderContext,
} from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";

export type Context = StorefrontRenderContext;

/** Classes from parts, falsy parts dropped; undefined when none is left (no empty `class`). */
export function cx(...parts: Array<string | false | null | undefined>): string | undefined {
  return parts.filter(Boolean).join(" ") || undefined;
}

/** A setting's text, or null when it is unset or blank. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** One of `allowed`, else `fallback` (a value from an older schema). */
export function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function list<Item>(value: Item[] | null | undefined): Item[] {
  return Array.isArray(value) ? value : [];
}

/** A whole number within bounds, else the fallback. */
export function whole(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** "৳ 4,501 OFF": the amount saved, as the source store words its pill (an amount, not a percentage). */
export function savedLabel(context: Context, card: Pick<StorefrontProductCard, "price" | "compareAt">): string | null {
  if (!card.compareAt) return null;
  const saved = card.compareAt.amount - card.price.amount;
  if (!(saved > 0)) return null;
  return t(context, { en: `${formatMoney(context, saved)} OFF`, bn: `${formatMoney(context, saved)} ছাড়` });
}

export function Section({ name, children, label, id }: { name: string; children: Renderable; label?: string | null; id?: string }) {
  return (
    <section class={cx("volt-s", `volt-s-${name}`)} aria-label={label ?? undefined} id={id}>
      <div class="volt-wrap">{children}</div>
    </section>
  );
}

/** A section's head: the title (and a line under it) at the start, a link or tabs at the end. */
export function SectionHead({ title, subtitle, link, linkLabel, children, centered = false }: {
  title?: string | null;
  subtitle?: string | null;
  link?: string | null;
  linkLabel?: string | null;
  children?: Renderable;
  centered?: boolean;
}) {
  if (!title && !subtitle && !children && !(link && linkLabel)) return null;
  return (
    <div class={cx("volt-head", centered && "is-centered")}>
      <div class="volt-head-words">
        {title ? <h2 class="volt-h2">{title}</h2> : null}
        {subtitle ? <p class="volt-sub">{subtitle}</p> : null}
      </div>
      {children}
      {link && linkLabel ? <a class="volt-more" href={link}>{linkLabel}<Icon name="chevron" size={14} /></a> : null}
    </div>
  );
}

export interface CardOptions {
  /** "Shop Now" under the price (listings), or nothing (home rows). */
  button: "shop" | "cart" | "none";
  eager?: boolean;
}

/** The product card: a square photo with the saved-amount pill, two lines of name, the price beside the regular price. */
export function ProductCard({ product, context, options }: { product: StorefrontProductCard; context: Context; options: CardOptions }) {
  const saved = savedLabel(context, product);
  const shop = t(context, { en: "Shop Now", bn: "এখনই কিনুন" });
  return (
    <article class={cx("volt-card", product.soldOut && "is-sold-out")}>
      <a class="volt-card-media" href={product.url} tabindex="-1" aria-hidden="true">
        {product.image
          ? <Image image={product.image} sizes="(min-width: 80rem) 16vw, (min-width: 48rem) 25vw, 50vw" loading={options.eager ? "eager" : "lazy"} fetchpriority={options.eager ? "auto" : undefined} />
          : <span class="volt-card-blank" />}
      </a>
      {saved ? <span class="volt-pill">{saved}</span> : null}
      {product.soldOut ? <span class="volt-pill is-muted volt-pill-end">{t(context, { en: "Out of stock", bn: "স্টক নেই" })}</span> : null}
      <div class="volt-card-body">
        <h3 class="volt-card-title"><a href={product.url}>{product.title}</a></h3>
        <p class="volt-card-price">
          {product.priceVaries ? <span class="volt-from">{t(context, { en: "From", bn: "শুরু" })}</span> : null}
          <span class="volt-now">{product.price.formatted}</span>
          {product.compareAt ? (
            <del class="volt-was"><span class="volt-sr">{t(context, { en: "Regular price", bn: "নিয়মিত দাম" })}</span>{product.compareAt.formatted}</del>
          ) : null}
        </p>
        {options.button === "cart" && product.quickAdd && !product.soldOut ? (
          <a class="volt-btn is-line is-small" href={product.url} {...quickAdd(product)}>
            <Icon name="cart" size={16} />{t(context, { en: "Add to Cart", bn: "কার্টে যোগ করুন" })}
          </a>
        ) : options.button !== "none" ? (
          <a class="volt-btn is-line is-small" href={product.url}>{shop}</a>
        ) : null}
      </div>
    </article>
  );
}

/** A grid of cards (`columns` on computers), or a scrolling row. */
export function CardGrid({ cards, context, columns = 5, row = false, button = "none", eagerFirst = 0 }: {
  cards: StorefrontProductCard[];
  context: Context;
  columns?: number;
  row?: boolean;
  button?: CardOptions["button"];
  eagerFirst?: number;
}) {
  if (cards.length === 0) return null;
  return (
    <ul class={cx("volt-grid", row && "is-row")} style={{ "--volt-cols": String(columns) }}>
      {cards.map((card, index) => (
        <li><ProductCard product={card} context={context} options={{ button, eager: index < eagerFirst }} /></li>
      ))}
    </ul>
  );
}
