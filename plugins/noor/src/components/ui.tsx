// Noor's building blocks: the section head every section opens with, the
// two button styles, stars and the product card every grid, rail and the
// card slot draw. All styling is in storefront.css (`noor-` classes) and
// reads the store's own tokens, so the merchant's colours, fonts, radius
// and container width apply everywhere.

import {
  Image,
  Price,
  editable,
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

export function SectionHead({ eyebrow, heading, body, link, linkLabel, align = "start", context }: {
  eyebrow?: string | null;
  heading?: string | null;
  body?: string | null;
  link?: string | null;
  linkLabel?: string | null;
  align?: "start" | "center";
  context: Context;
}) {
  if (!eyebrow && !heading && !body && !(link && linkLabel)) return null;
  return (
    <header class={cx("noor-head", align === "center" && "is-center")}>
      <div class="noor-head-copy">
        {eyebrow ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{eyebrow}</p> : null}
        {heading ? <h2 class="noor-title" {...editable(context, "heading")}>{heading}</h2> : null}
        {body ? <p class="noor-lede" {...editable(context, "text")}>{body}</p> : null}
      </div>
      {link && linkLabel ? (
        <a class="noor-link-arrow" href={link}>
          <span {...editable(context, "link_label")}>{linkLabel}</span>
          <Icon name="arrow" size={18} />
        </a>
      ) : null}
    </header>
  );
}

export function Button({ href, children, variant = "solid", editableKey, context, attrs = {} }: {
  href: string;
  children: Renderable;
  variant?: "solid" | "ghost" | "light";
  editableKey?: string;
  context: Context;
  attrs?: Record<string, string>;
}) {
  return (
    <a class={cx("noor-button", `is-${variant}`)} href={href} {...attrs}>
      <span {...(editableKey ? editable(context, editableKey) : {})}>{children}</span>
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

export interface CardOptions {
  ratio?: string;
  align?: string;
  action?: string;
  showRating?: boolean;
  showHover?: boolean;
  eager?: boolean;
  sizes?: string;
}

/** The Noor product card. */
export function ProductCard({ product, context, options = {} }: { product: StorefrontProductCard; context: Context; options?: CardOptions }) {
  const ratio = options.ratio ?? "portrait";
  const action = options.action ?? "icon";
  const hover = options.showHover !== false && product.hoverImage;
  const sizes = options.sizes ?? "(min-width: 1280px) 22vw, (min-width: 768px) 30vw, 46vw";
  const addLabel = product.quickAdd
    ? t(context, { en: `Add ${product.title} to cart`, bn: `${product.title} কার্টে যোগ করুন` })
    : t(context, { en: `Choose options for ${product.title}`, bn: `${product.title}: অপশন বাছুন` });
  return (
    <article class={cx("noor-card", `ratio-${ratio}`, options.align === "center" && "is-center", product.soldOut && "is-sold-out", hover && "has-hover")}>
      <div class="noor-card-media">
        <a href={product.url} tabindex="-1" aria-hidden="true" class="noor-card-photo">
          {product.image
            ? <Image image={product.image} sizes={sizes} loading={options.eager ? "eager" : "lazy"} alt="" class="noor-card-img" />
            : <span class="noor-card-placeholder">{product.title.slice(0, 1)}</span>}
          {hover ? <Image image={product.hoverImage} sizes={sizes} alt="" class="noor-card-img is-alt" /> : null}
        </a>
        <div class="noor-card-badges">
          {product.soldOut
            ? <span class="noor-badge is-muted">{t(context, { en: "Sold out", bn: "স্টক শেষ" })}</span>
            : product.percentOff ? <span class="noor-badge is-sale">−{product.percentOff}%</span> : null}
        </div>
        {action === "icon" && !product.soldOut ? (
          <a class="noor-card-quick" {...quickAdd(product)} aria-label={addLabel} title={addLabel}>
            <Icon name={product.quickAdd ? "plus" : "arrow"} size={18} />
          </a>
        ) : null}
      </div>
      <div class="noor-card-body">
        <h3 class="noor-card-title"><a href={product.url}>{product.title}</a></h3>
        {product.facts[0] ? <p class="noor-card-fact">{product.facts[0]}</p> : null}
        <div class="noor-card-meta">
          <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price" />
          {options.showRating !== false && product.rating ? (
            <span class="noor-card-rating" aria-label={t(context, { en: `Rated ${product.rating.average.toFixed(1)} of 5`, bn: `৫-এ ${product.rating.average.toFixed(1)}` })}>
              <span aria-hidden="true">★</span> {product.rating.average.toFixed(1)}
            </span>
          ) : null}
        </div>
        {action === "button" && !product.soldOut ? (
          <a class="noor-button is-ghost is-small noor-card-button" {...quickAdd(product)}>
            {product.quickAdd ? t(context, { en: "Add to cart", bn: "কার্টে যোগ করুন" }) : t(context, { en: "Choose options", bn: "অপশন বাছুন" })}
          </a>
        ) : null}
      </div>
    </article>
  );
}
