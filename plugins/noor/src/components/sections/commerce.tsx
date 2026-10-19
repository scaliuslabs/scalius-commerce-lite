// Noor's selling markup: products with tabs (radio tabs, no script), a
// featured product (Noor's own section), shop the look (a photo with
// hotspots beside its products), collection tiles (mosaic, row or circles),
// promo tiles and a sale banner with a live countdown. Everything but the
// featured product is drawn by a skin of the matching core section
// (../skins.tsx), which maps the core section's data onto these settings.

import {
  Image,
  Island,
  Price,
  editable,
  quickAdd,
  storeTime,
  t,
  type SectionProps,
  type StorefrontImage,
  type StorefrontProductCard,
} from "@scalius/plugin-sdk/storefront";
import { Icon } from "../icons";
import { Button, Products, Rail, Section, SectionHead, Stars, choice, cx, percent, ratingLabel, ratingValue, reviewCount, text, type Context } from "../ui";

// ── Products with tabs ───────────────────────────────────────────────────

export interface ShowcaseSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  link: string | null;
  link_label: string | null;
  tabs: Array<{ label: string | null; products: StorefrontProductCard[] }>;
  layout: string;
  columns: number;
  tone: string;
  spacing: string;
  /** The page's lead section (a skin of a core section passes the host's `aboveFold`): the first tab's first row loads eagerly. */
  eager?: boolean;
}

export function ProductShowcase({ settings, context, instanceId }: SectionProps<ShowcaseSettings>) {
  const tabs = settings.tabs
    .map((tab) => ({ label: text(tab.label), products: tab.products }))
    .filter((tab) => tab.products.length > 0);
  if (tabs.length === 0) return null;
  const layout = choice(settings.layout, ["grid", "row"] as const, "grid");
  const name = `noor-tab-${instanceId}`;
  const heading = text(settings.heading);
  // Only the first tab shows before a choice; the other tabs stay lazy.
  const list = (products: StorefrontProductCard[], first: boolean) => (
    <Products products={products} context={context} layout={layout} columns={settings.columns} label={heading}
      card={settings.eager === true && first ? { eager: true } : undefined} />
  );
  return (
    <Section name="showcase" tone={settings.tone} space={settings.spacing}>
      <SectionHead eyebrow={text(settings.eyebrow)} heading={heading} body={text(settings.text)}
        link={text(settings.link)} linkLabel={text(settings.link_label)} context={context} />
      {tabs.length > 1 ? (
        <div class="noor-tabs">
          <div class="noor-tablist" role="radiogroup" aria-label={heading ?? t(context, { en: "Products", bn: "পণ্য" })}>
            {tabs.map((tab, index) => (
              <label class="noor-tab">
                <input type="radio" name={name} value={String(index)} checked={index === 0} class="noor-tab-input" />
                <span>{tab.label ?? `${index + 1}`}</span>
              </label>
            ))}
          </div>
          {tabs.map((tab, index) => <div class="noor-tabpanel" data-panel={String(index)}>{list(tab.products, index === 0)}</div>)}
        </div>
      ) : list(tabs[0]!.products, true)}
    </Section>
  );
}

// ── Featured product ─────────────────────────────────────────────────────

export interface FeaturedSettings {
  product: StorefrontProductCard | null;
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  image: StorefrontImage | null;
  points: Array<{ text: string | null }>;
  button: string | null;
  image_side: string;
  tone: string;
  spacing: string;
}

export function FeaturedProduct({ settings, context }: SectionProps<FeaturedSettings>) {
  const product = settings.product;
  if (!product) return null;
  const photo = settings.image ?? product.image;
  const points = settings.points.flatMap((point) => (text(point.text) ? [text(point.text)!] : []));
  return (
    <Section name="feature" tone={settings.tone} space={settings.spacing}>
      <div class={cx("noor-split", settings.image_side === "end" && "is-flipped")}>
        <a class="noor-split-media noor-feature-media" href={product.url} tabindex="-1" aria-hidden="true">
          {photo ? <Image image={photo} sizes="(min-width: 768px) 50vw, 100vw" alt="" class="noor-cover" /> : null}
          {product.hoverImage && !settings.image ? <Image image={product.hoverImage} sizes="(min-width: 768px) 50vw, 100vw" alt="" class="noor-cover is-alt" /> : null}
          {product.percentOff ? <span class="noor-badge is-sale">−{percent(context, product.percentOff)}</span> : null}
        </a>
        <div class="noor-split-copy">
          {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
          <h2 class="noor-h2"><a href={product.url} {...editable(context, "heading")}>{text(settings.heading) ?? product.title}</a></h2>
          {product.rating ? (
            <p class="noor-rating-line">
              <Stars value={product.rating.average} label={ratingLabel(context, product.rating.average, product.rating.count)} />
              <span>{ratingValue(context, product.rating.average)} · {reviewCount(context, product.rating.count)}</span>
            </p>
          ) : null}
          <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price is-large" />
          {text(settings.text) ? <p class="noor-lede" {...editable(context, "text")}>{settings.text}</p> : null}
          {points.length > 0 ? (
            <ul class="noor-checks">{points.map((point) => <li><Icon name="check" size={16} />{point}</li>)}</ul>
          ) : null}
          <div class="noor-actions-row">
            {product.soldOut
              ? <span class="noor-badge is-muted is-inline">{t(context, { en: "Sold out", bn: "স্টক শেষ" })}</span>
              : <a class="noor-btn is-solid is-large" {...quickAdd(product)}>
                <span {...editable(context, "button")}>{text(settings.button) ?? (product.quickAdd ? t(context, { en: "Add to cart", bn: "কার্টে যোগ করুন" }) : t(context, { en: "Choose options", bn: "অপশন বাছুন" }))}</span>
              </a>}
            <a class="noor-more" href={product.url}>{t(context, { en: "View details", bn: "বিস্তারিত দেখুন" })}<Icon name="arrow" size={16} /></a>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ── Shop the look ────────────────────────────────────────────────────────

export interface LookSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  image: StorefrontImage | null;
  hotspots: Array<{ x: number | null; y: number | null; title: string | null; text: string | null; link: string | null }>;
  products: StorefrontProductCard[];
  image_side: string;
  tone: string;
  spacing: string;
}

export function ShopTheLook({ settings, context }: SectionProps<LookSettings>) {
  if (!settings.image) return null;
  const spots = settings.hotspots.filter((spot) => text(spot.title));
  return (
    <Section name="look" tone={settings.tone} space={settings.spacing}>
      <div class={cx("noor-split is-look", settings.image_side === "end" && "is-flipped")}>
        <div class="noor-split-media noor-look-media">
          <Image image={settings.image} sizes="(min-width: 768px) 50vw, 100vw" class="noor-cover" />
          {spots.map((spot, index) => (
            <details class="noor-spot" style={{ left: `${Math.max(4, Math.min(96, spot.x ?? 50))}%`, top: `${Math.max(4, Math.min(96, spot.y ?? 50))}%` }}>
              <summary aria-label={spot.title!}><span aria-hidden="true">{index + 1}</span></summary>
              <div class="noor-spot-card">
                <strong>{spot.title}</strong>
                {text(spot.text) ? <p>{spot.text}</p> : null}
                {text(spot.link) ? <a href={spot.link!} class="noor-more">{t(context, { en: "View", bn: "দেখুন" })}<Icon name="arrow" size={14} /></a> : null}
              </div>
            </details>
          ))}
        </div>
        <div class="noor-split-copy noor-look-side">
          <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} body={text(settings.text)} context={context} />
          {settings.products.length > 0 ? (
            <Products products={settings.products} context={context} columns={2} card={{ action: "icon", sizes: "(min-width: 768px) 22vw, 46vw" }} />
          ) : null}
        </div>
      </div>
    </Section>
  );
}

// ── Collection tiles ─────────────────────────────────────────────────────

export interface TilesSettings {
  eyebrow: string | null;
  heading: string | null;
  link: string | null;
  link_label: string | null;
  tiles: Array<{ image: StorefrontImage | null; title: string | null; subtitle: string | null; link: string | null }>;
  layout: string;
  tone: string;
  spacing: string;
}

export function CollectionTiles({ settings, context }: SectionProps<TilesSettings>) {
  const tiles = settings.tiles.filter((tile) => tile.image && text(tile.title)).slice(0, 8);
  if (tiles.length === 0) return null;
  const layout = choice(settings.layout, ["mosaic", "row", "circles"] as const, "mosaic");
  const heading = text(settings.heading);
  const tile = (item: TilesSettings["tiles"][number], index: number) => {
    const body = (
      <>
        <span class="noor-tile-photo">
          <Image image={item.image} alt="" class="noor-cover"
            sizes={layout === "circles" ? "160px" : layout === "mosaic" && index === 0 ? "(min-width: 768px) 50vw, 100vw" : "(min-width: 768px) 25vw, 50vw"} />
        </span>
        <span class="noor-tile-copy">
          <span class="noor-tile-title">{item.title}</span>
          {text(item.subtitle) && layout !== "circles" ? <span class="noor-tile-sub">{item.subtitle}</span> : null}
        </span>
      </>
    );
    return <li class="noor-tile" data-slide>{text(item.link) ? <a href={item.link!}>{body}</a> : <div>{body}</div>}</li>;
  };
  const list = <ul class={cx("noor-tiles", `is-${layout}`, `count-${Math.min(tiles.length, 5)}`)} data-track tabindex={layout === "mosaic" ? undefined : "0"}>{tiles.map(tile)}</ul>;
  return (
    <Section name="tiles" tone={settings.tone} space={settings.spacing}>
      <SectionHead eyebrow={text(settings.eyebrow)} heading={heading} link={text(settings.link)} linkLabel={text(settings.link_label)} context={context} />
      {layout === "mosaic" ? list : <Rail label={heading ?? t(context, { en: "Collections", bn: "কালেকশন" })} context={context}>{list}</Rail>}
    </Section>
  );
}

// ── Promo tiles ──────────────────────────────────────────────────────────

export interface PromosSettings {
  items: Array<{ image: StorefrontImage | null; eyebrow: string | null; heading: string | null; label: string | null; link: string | null }>;
  height: string;
  tone: string;
  spacing: string;
}

export function PromoTiles({ settings }: SectionProps<PromosSettings>) {
  const items = settings.items.filter((item) => item.image).slice(0, 3);
  if (items.length === 0) return null;
  return (
    <Section name="promos" tone={settings.tone} space={settings.spacing}>
      <ul class={cx("noor-promos", `count-${items.length}`, `h-${choice(settings.height, ["s", "m", "l"] as const, "m")}`)}>
        {items.map((item) => {
          const link = text(item.link);
          const body = (
            <>
              {/* The words name the tile; a photo-only link is named by its photo's alt text. */}
              <Image image={item.image} alt={text(item.heading) || text(item.label) ? "" : item.image?.alt ?? ""} class="noor-cover" sizes={items.length === 1 ? "100vw" : "(min-width: 768px) 50vw, 100vw"} />
              <span class="noor-promo-copy">
                {text(item.eyebrow) ? <span class="noor-eyebrow">{item.eyebrow}</span> : null}
                {text(item.heading) ? <span class="noor-promo-title">{item.heading}</span> : null}
                {text(item.label) ? <span class="noor-promo-link">{item.label}<Icon name="arrow" size={16} /></span> : null}
              </span>
            </>
          );
          return <li class="noor-promo">{link ? <a href={link}>{body}</a> : <div>{body}</div>}</li>;
        })}
      </ul>
    </Section>
  );
}

// ── Sale banner with a countdown ─────────────────────────────────────────

export interface CountdownSettings {
  image?: StorefrontImage | null;
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  /** When the sale ends, as epoch ms (a running promotion's end, or a typed time through `countdownEnd`). */
  end: number | null;
  label: string | null;
  link: string | null;
  tone: string;
  spacing: string;
}

/**
 * An end time the merchant typed (`2026-12-31` or `2026-12-31 18:00`) in the
 * store's time zone, as epoch ms; null when it is not one. A date alone ends
 * at the end of that day.
 */
export function countdownEnd(value: string | null, timeZone: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const [, date, hour, minute] = match;
  const at = (zone: string) => storeTime({ store: { timeZone: zone } }, date!, Number(hour ?? 23), Number(minute ?? 59));
  // An unknown zone counts in UTC (an impossible date is null in every zone).
  const end = at(timeZone) ?? at("UTC");
  return end === null || hour !== undefined ? end : end + 59_000;
}

export function Countdown({ end, context, size = "m" }: { end: number; context: Context; size?: "s" | "m" }) {
  const units = [
    { key: "days", en: "Days", bn: "দিন" },
    { key: "hours", en: "Hrs", bn: "ঘণ্টা" },
    { key: "minutes", en: "Min", bn: "মিনিট" },
    { key: "seconds", en: "Sec", bn: "সেকেন্ড" },
  ];
  return (
    <Island name="countdown" hydrate="idle" props={{ end }} class={cx("noor-timer", `is-${size}`)}>
      <ol class="noor-timer-list" aria-live="off">
        {units.map((unit) => (
          <li><span class="noor-timer-value" data-unit={unit.key}>--</span><span class="noor-timer-label">{t(context, unit)}</span></li>
        ))}
      </ol>
    </Island>
  );
}

export function PromoCountdown({ settings, context }: SectionProps<CountdownSettings>) {
  const heading = text(settings.heading);
  if (!heading) return null;
  const tone = choice(settings.tone, ["ink", "accent", "soft"] as const, "ink");
  return (
    <Section name="sale" space={settings.spacing}>
      <div class={cx("noor-sale", `is-${tone}`, settings.image && "has-image")}>
        {settings.image ? <Image image={settings.image} alt="" class="noor-sale-image noor-cover" sizes="100vw" /> : null}
        <div class="noor-sale-copy">
          {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
          <h2 class="noor-h2" {...editable(context, "heading")}>{heading}</h2>
          {text(settings.text) ? <p class="noor-lede" {...editable(context, "text")}>{settings.text}</p> : null}
        </div>
        {settings.end ? <Countdown end={settings.end} context={context} /> : null}
        {text(settings.label) && text(settings.link) ? (
          <Button href={settings.link!} variant={tone === "soft" ? "solid" : "light"} size="large" editableKey="label" context={context}>{settings.label}</Button>
        ) : null}
      </div>
    </Section>
  );
}
