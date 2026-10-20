// Bazaar's building blocks: helpers, stars, the price line with
// superscript cents, badges and the product card every grid, row and the
// card skin share. Styling lives in storefront.css (`bz-` classes) on the
// store's own tokens, so a merchant's colours still apply.

import {
  Image,
  Island,
  formatNumber,
  plural,
  quickAdd,
  t,
  type Renderable,
  type StorefrontMoney,
  type StorefrontProductCard,
  type StorefrontRenderContext,
} from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";

export type Context = StorefrontRenderContext;

/** The sellers app's storefront-visible product fields (`scalius.sellers`); Bazaar shows them when present. */
export const SELLER_NAME_FIELD = "scalius.sellers.seller_name";
export const SELLER_HANDLE_FIELD = "scalius.sellers.seller_handle";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** A setting's text, or null when it is unset or blank. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/** A custom-field value as plain text (single-line text fields arrive as strings). */
export function fieldText(fields: Record<string, unknown> | undefined, key: string): string | null {
  const value = fields?.[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

/** The seller a product is sold by, from the sellers app's fields; null when the store sells it itself. */
export function soldBy(fields: Record<string, unknown> | undefined): { name: string; url: string | null } | null {
  const name = fieldText(fields, SELLER_NAME_FIELD);
  if (!name) return null;
  const handle = fieldText(fields, SELLER_HANDLE_FIELD);
  return { name, url: handle && /^[a-z0-9-]{1,100}$/.test(handle) ? `/apps/scalius.sellers/store/${handle}` : null };
}

export function ratingValue(context: Context, average: number): string {
  return formatNumber(context, average, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function ratingCount(context: Context, count: number): string {
  return plural(context, count, { en: { one: "# rating", other: "# ratings" }, bn: { other: "#টি রেটিং" } });
}

export function ratingLabel(context: Context, average: number, count: number): string {
  const value = ratingValue(context, average);
  return t(context, { en: `${value} out of 5 stars, ${ratingCount(context, count)}`, bn: `৫-এর মধ্যে ${value}, ${ratingCount(context, count)}` });
}

/** Five stars filled to the nearest half, as the marketplace draws them. */
export function Stars({ value, label, size = "s" }: { value: number; label: string; size?: "s" | "m" }) {
  const halves = Math.round(Math.max(0, Math.min(5, value)) * 2);
  return (
    <span class={cx("bz-stars", `is-${size}`)} role="img" aria-label={label}>
      {[0, 1, 2, 3, 4].map((index) => {
        const fill = halves >= (index + 1) * 2 ? "full" : halves === index * 2 + 1 ? "half" : "empty";
        return <span class={`bz-star is-${fill}`} aria-hidden="true" />;
      })}
    </span>
  );
}

/**
 * The marketplace price: a small currency sign, the whole amount large and
 * the fraction as superscript, from the store's own formatting (so the
 * merchant's currency and digits stay right). Falls back to the formatted
 * string when it cannot be split.
 */
export function BigPrice({ money, label }: { money: StorefrontMoney; context?: Context; label?: string }) {
  const formatted = money.formatted;
  // Digits in Latin, Devanagari or Bengali; the fraction is the last two digits after a separator, when there is one.
  const match = /^(\D*?)([\d\u0966-\u096f\u09e6-\u09ef][\d\u0966-\u096f\u09e6-\u09ef.,\s]*?)(?:([.,])([\d\u0966-\u096f\u09e6-\u09ef]{2}))?(\D*)$/.exec(formatted);
  if (!match) return <span class="bz-price-big">{formatted}</span>;
  const [, before, whole, , fraction, after] = match;
  return (
    <span class="bz-price-big">
      <span class="bz-sr">{label ?? formatted}</span>
      <span aria-hidden="true">
        {before?.trim() ? <span class="bz-price-sym">{before.trim()}</span> : null}
        <span class="bz-price-whole">{whole}</span>
        {fraction ? <span class="bz-price-frac">{fraction}</span> : null}
        {after?.trim() ? <span class="bz-price-sym">{after.trim()}</span> : null}
      </span>
    </span>
  );
}

/** "-15%" in the store's numerals. */
export function percentOff(context: Context, value: number): string {
  return `-${formatNumber(context, value / 100, { style: "percent" })}`;
}

export function DealBadge({ context, percent }: { context: Context; percent: number | null }) {
  return (
    <span class="bz-deal">
      {percent ? <span class="bz-deal-pct">{t(context, { en: `${formatNumber(context, percent)}% off`, bn: `${formatNumber(context, percent)}% ছাড়` })}</span> : null}
      <span class="bz-deal-label">{t(context, { en: "Limited time deal", bn: "সীমিত সময়ের অফার" })}</span>
    </span>
  );
}

/** The fast-delivery check mark (a prime-style badge): shown for products the merchant marks with a fact. */
export function FastBadge({ context, label }: { context: Context; label: string | null }) {
  if (!label) return null;
  return (
    <span class="bz-fast" title={label}>
      <Icon name="check" size={14} />
      <span class="bz-fast-word">{label}</span>
      <span class="bz-sr">{t(context, { en: "fast delivery", bn: "দ্রুত ডেলিভারি" })}</span>
    </span>
  );
}

export interface CardOptions {
  layout?: "grid" | "row" | "list";
  eager?: boolean;
  showRating?: boolean;
  showAdd?: boolean;
  fastLabel?: string | null;
  showSeller?: boolean;
  sizes?: string;
}

/**
 * The marketplace product card: the photo on a light panel, the title
 * clamped to a few lines, stars with the count, the big price with the
 * struck list price, the fast-delivery badge, the first delivery fact, and
 * a yellow "Add to cart" pill for simple products ("See options"
 * otherwise). Everything works without JavaScript; the add button is the
 * store's own quick add.
 */
export function ProductCard({ product, context, options = {} }: { product: StorefrontProductCard; context: Context; options?: CardOptions }) {
  const layout = options.layout ?? "grid";
  const seller = options.showSeller === false ? null : soldBy(product.fields);
  const sizes = options.sizes ?? (layout === "row" ? "200px" : "(min-width: 1024px) 22vw, 46vw");
  return (
    <article class={cx("bz-card", `is-${layout}`, product.soldOut && "is-sold-out")}>
      <a class="bz-card-media" href={product.url} tabindex="-1" aria-hidden="true">
        {product.image
          ? <Image image={product.image} sizes={sizes} loading={options.eager ? "eager" : "lazy"} alt="" class="bz-card-img" />
          : <span class="bz-card-blank"><Icon name="box" size={40} /></span>}
      </a>
      <div class="bz-card-body">
        {product.percentOff && !product.soldOut ? <DealBadge context={context} percent={product.percentOff} /> : null}
        <h3 class="bz-card-title"><a href={product.url}>{product.title}</a></h3>
        {seller ? <p class="bz-card-seller">{t(context, { en: `by ${seller.name}`, bn: `বিক্রেতা: ${seller.name}` })}</p> : null}
        {options.showRating !== false && product.rating ? (
          <p class="bz-card-rating">
            <Stars value={product.rating.average} label={ratingLabel(context, product.rating.average, product.rating.count)} />
            <span class="bz-card-count" aria-hidden="true">{formatNumber(context, product.rating.count)}</span>
          </p>
        ) : null}
        <p class="bz-card-price">
          {product.priceVaries ? <span class="bz-from">{t(context, { en: "From", bn: "থেকে" })}</span> : null}
          <BigPrice money={product.price} context={context} />
          {product.compareAt ? (
            <span class="bz-list">
              <span class="bz-sr">{t(context, { en: "List price:", bn: "তালিকা মূল্য:" })}</span>
              <s>{product.compareAt.formatted}</s>
            </span>
          ) : null}
        </p>
        {product.soldOut ? (
          <p class="bz-card-stock is-out">{t(context, { en: "Currently unavailable.", bn: "এখন পাওয়া যাচ্ছে না।" })}</p>
        ) : (
          <>
            <FastBadge context={context} label={options.fastLabel ?? null} />
            {product.facts[0] ? <p class="bz-card-fact">{product.facts[0]}</p> : null}
          </>
        )}
        {options.showAdd !== false && !product.soldOut ? (
          <a class={cx("bz-pill", product.quickAdd ? "is-add" : "is-options")} {...quickAdd(product)}
            aria-label={product.quickAdd
              ? t(context, { en: `Add ${product.title} to cart`, bn: `${product.title} কার্টে যোগ করুন` })
              : t(context, { en: `See options for ${product.title}`, bn: `${product.title}: অপশন দেখুন` })}>
            {product.quickAdd ? t(context, { en: "Add to cart", bn: "কার্টে যোগ করুন" }) : t(context, { en: "See options", bn: "অপশন দেখুন" })}
          </a>
        ) : null}
      </div>
    </article>
  );
}

/** A horizontal carousel with arrow buttons on computers (the `rail` island); the row scrolls on its own without it. */
export function Rail({ label, context, children, kind = "products" }: { label: string; context: Context; children: Renderable; kind?: "products" | "images" }) {
  return (
    <Island name="rail" hydrate="visible" class="bz-rail-island">
      <div class={cx("bz-rail", `is-${kind}`)} role="region" aria-label={label}>
        <button type="button" class="bz-rail-arrow is-prev" data-prev hidden aria-label={t(context, { en: "Previous", bn: "আগের" })}><Icon name="back" size={28} /></button>
        <ul class="bz-rail-track" data-track tabindex="0">{children}</ul>
        <button type="button" class="bz-rail-arrow is-next" data-next hidden aria-label={t(context, { en: "Next", bn: "পরের" })}><Icon name="chevron" size={28} /></button>
      </div>
    </Island>
  );
}

/** A white band with a title, an optional "See more" link and its content (carousels, grids). */
export function Band({ title, link, linkLabel, children, class: className }: { title?: string | null; link?: string | null; linkLabel?: string | null; children: Renderable; class?: string }) {
  return (
    <section class={cx("bz-band", className)}>
      {title || (link && linkLabel) ? (
        <header class="bz-band-head">
          {title ? <h2 class="bz-band-title">{title}</h2> : null}
          {link && linkLabel ? <a class="bz-link" href={link}>{linkLabel}</a> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
