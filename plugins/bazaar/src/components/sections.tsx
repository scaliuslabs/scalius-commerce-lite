// Bazaar's homepage pieces: its own sections (the four-card row with single
// or 2x2 photo cards, the deal row and the image row of products) and its
// skins of the store's own sections (the hero carousel that fades into the
// page, product rows, the deal block and category tiles as quad cards),
// plus the listing page skin (results bar, filter rail, card grid).

import {
  Filters,
  Image,
  Island,
  Pagination,
  Toolbar,
  editable,
  formatNumber,
  t,
  type ListingMainProps,
  type SectionProps,
  type SectionSkinProps,
  type StorefrontImage,
  type StorefrontProductCard,
  type StorefrontTile,
} from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";
import { Band, BigPrice, DealBadge, ProductCard, Rail, cx, text, type Context } from "./ui";

// ── Cards row ────────────────────────────────────────────────────────────

type Photo = StorefrontImage | null;
interface CardItem {
  title: string | null;
  link: string | null;
  link_label: string | null;
  image: Photo;
  caption: string | null;
  image_2: Photo;
  caption_2: string | null;
  image_3: Photo;
  caption_3: string | null;
  image_4: Photo;
  caption_4: string | null;
}

interface CardRowSettings {
  cards: CardItem[];
  overlap: boolean;
}

function MerchCard({ card, context, eager }: { card: CardItem; context: Context; eager: boolean }) {
  const quad = [
    { image: card.image, caption: card.caption },
    { image: card.image_2, caption: card.caption_2 },
    { image: card.image_3, caption: card.caption_3 },
    { image: card.image_4, caption: card.caption_4 },
  ].filter((tile) => tile.image);
  const link = text(card.link);
  const label = text(card.link_label) ?? t(context, { en: "See more", bn: "আরও দেখুন" });
  return (
    <article class="bz-merch">
      {text(card.title) ? <h2 class="bz-merch-title">{text(card.title)}</h2> : null}
      {quad.length >= 4 ? (
        <ul class="bz-merch-quad">
          {quad.map((tile) => (
            <li>
              <a href={link ?? "#"} class="bz-merch-tile">
                <Image image={tile.image} sizes="(min-width: 1024px) 140px, 40vw" loading={eager ? "eager" : "lazy"} fetchpriority={eager ? "auto" : undefined} alt="" />
                {text(tile.caption) ? <span>{text(tile.caption)}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      ) : quad[0] ? (
        <a href={link ?? "#"} class="bz-merch-single" aria-label={text(card.title) ?? label}>
          <Image image={quad[0].image} sizes="(min-width: 1024px) 300px, 80vw" loading={eager ? "eager" : "lazy"} fetchpriority={eager ? "auto" : undefined} alt={text(quad[0].caption) ?? ""} />
        </a>
      ) : <span class="bz-merch-blank"><Icon name="box" size={48} /></span>}
      {link ? <a class="bz-link bz-merch-more" href={link}>{label}</a> : null}
    </article>
  );
}

export function CardRow({ settings, context }: SectionProps<CardRowSettings>) {
  const cards = (settings.cards ?? []).filter((card) => text(card.title) || card.image);
  if (cards.length === 0) return null;
  return (
    <section class={cx("bz-cards", settings.overlap && "is-overlap")}>
      <div class="bz-cards-grid">{cards.slice(0, 8).map((card, index) => <MerchCard card={card} context={context} eager={settings.overlap && index < 4} />)}</div>
    </section>
  );
}

// ── Deal row and image row ───────────────────────────────────────────────

interface DealRowSettings {
  heading: string | null;
  products: StorefrontProductCard[];
  link: string | null;
  link_label: string | null;
}

function DealItem({ product, context }: { product: StorefrontProductCard; context: Context }) {
  return (
    <li class="bz-deal-item">
      <a href={product.url} class="bz-deal-photo" tabindex="-1" aria-hidden="true">
        {product.image ? <Image image={product.image} sizes="220px" alt="" /> : <span class="bz-card-blank"><Icon name="box" size={40} /></span>}
      </a>
      <DealBadge context={context} percent={product.percentOff} />
      <p class="bz-deal-price">
        <BigPrice money={product.price} context={context} />
        {product.compareAt ? <span class="bz-list">{t(context, { en: "List:", bn: "তালিকা:" })} <s>{product.compareAt.formatted}</s></span> : null}
      </p>
      <a class="bz-deal-title" href={product.url}>{product.title}</a>
    </li>
  );
}

export function DealRow({ settings, context }: SectionProps<DealRowSettings>) {
  const products = settings.products ?? [];
  if (products.length === 0) return null;
  const heading = text(settings.heading) ?? t(context, { en: "Today's Deals", bn: "আজকের অফার" });
  return (
    <Band title={heading} link={text(settings.link)} linkLabel={text(settings.link_label) ?? t(context, { en: "See all deals", bn: "সব অফার দেখুন" })}>
      <Rail label={heading} context={context}>{products.map((product) => <DealItem product={product} context={context} />)}</Rail>
    </Band>
  );
}

interface ImageRowSettings {
  heading: string | null;
  products: StorefrontProductCard[];
  link: string | null;
  link_label: string | null;
}

/** A row of product photos only, as the marketplace's "Best Sellers in ..." rows. */
export function ImageRow({ settings, context }: SectionProps<ImageRowSettings>) {
  const products = (settings.products ?? []).filter((product) => product.image);
  if (products.length === 0) return null;
  const heading = text(settings.heading) ?? t(context, { en: "Best Sellers", bn: "সেরা বিক্রিত" });
  return (
    <Band title={heading} link={text(settings.link)} linkLabel={text(settings.link_label)}>
      <Rail label={heading} context={context} kind="images">
        {products.map((product) => (
          <li class="bz-image-item"><a href={product.url} aria-label={product.title}><Image image={product.image} sizes="200px" alt="" /></a></li>
        ))}
      </Rail>
    </Band>
  );
}

// ── Skins of the store's sections ────────────────────────────────────────

/** The store's hero as the marketplace carousel: full width, arrows on the sides, the photo fading into the page. */
export function HeroSkin({ data, context, settings }: SectionSkinProps<"hero", { fade: boolean; interval: number }>) {
  const slides = data.settings.slides.filter((slide) => slide.image);
  if (slides.length === 0) return null;
  const eager = data.aboveFold === true;
  const label = t(context, { en: "Featured offers", bn: "বিশেষ অফার" });
  return (
    <section class={cx("bz-hero", settings.fade !== false && "is-fade")} aria-roledescription="carousel" aria-label={label}>
      <Island name="hero" hydrate="idle" props={{ interval: Math.max(3, Math.min(12, Number(settings.interval) || 6)) }}>
        <ul class="bz-hero-track" data-track>
          {slides.map((slide, index) => (
            <li class="bz-hero-slide" data-slide aria-roledescription="slide" aria-label={`${index + 1} / ${slides.length}`}>
              {slide.link ? (
                <a href={slide.link} aria-label={slide.alt || slide.heading || label}>
                  <Image image={slide.image} sizes="100vw" loading={eager && index === 0 ? "eager" : "lazy"} alt={slide.alt} />
                </a>
              ) : <Image image={slide.image} sizes="100vw" loading={eager && index === 0 ? "eager" : "lazy"} alt={slide.alt} />}
            </li>
          ))}
        </ul>
        {slides.length > 1 ? (
          <>
            <button type="button" class="bz-hero-arrow is-prev" data-prev aria-label={t(context, { en: "Previous slide", bn: "আগের স্লাইড" })}><Icon name="back" size={40} /></button>
            <button type="button" class="bz-hero-arrow is-next" data-next aria-label={t(context, { en: "Next slide", bn: "পরের স্লাইড" })}><Icon name="chevron" size={40} /></button>
          </>
        ) : null}
      </Island>
    </section>
  );
}

/** A product row of the store's as a card carousel. */
export function ProductRowSkin({ data, context, settings }: SectionSkinProps<"product-rail", { link_label: string | null }>) {
  const list = data.settings.products;
  if (list.cards.length === 0) return null;
  const heading = data.settings.title || list.title;
  return (
    <Band title={heading} link={list.url} linkLabel={text(settings.link_label) ?? t(context, { en: "See more", bn: "আরও দেখুন" })}>
      <Rail label={heading} context={context}>
        {list.cards.map((product) => <li class="bz-rail-card"><ProductCard product={product} context={context} options={{ layout: "row", showAdd: false }} /></li>)}
      </Rail>
    </Band>
  );
}

/** The store's deal block as the deal row, with the promotion's end when it has one. */
export function DealsSkin({ data, context }: SectionSkinProps<"deal-block">) {
  const list = data.settings.products;
  if (list.cards.length === 0) return null;
  const heading = data.settings.title || list.title || t(context, { en: "Today's Deals", bn: "আজকের অফার" });
  const ends = data.settings.promotion?.endsAt ?? null;
  return (
    <Band title={heading} link={list.url} linkLabel={t(context, { en: "See all deals", bn: "সব অফার দেখুন" })} class="bz-deals">
      {ends ? <p class="bz-deals-ends">{t(context, { en: "Ends soon", bn: "শীঘ্রই শেষ" })}</p> : null}
      <Rail label={heading} context={context}>{list.cards.map((product) => <DealItem product={product} context={context} />)}</Rail>
    </Band>
  );
}

/** The store's category tiles as quad cards: four categories to a card, a title per card. */
export function QuadTilesSkin({ data, context, settings }: SectionSkinProps<"category-tiles", { link_label: string | null }>) {
  const tiles = data.settings.categories.filter((tile) => tile.image);
  if (tiles.length === 0) return null;
  const groups: StorefrontTile[][] = [];
  for (let index = 0; index < tiles.length && groups.length < 4; index += 4) groups.push(tiles.slice(index, index + 4));
  return (
    <section class="bz-cards">
      <div class="bz-cards-grid">
        {groups.map((group, index) => (
          <article class="bz-merch">
            <h2 class="bz-merch-title" {...(index === 0 ? editable(context, "title") : {})}>{index === 0 && data.settings.title ? data.settings.title : group[0]!.title}</h2>
            <ul class="bz-merch-quad">
              {group.map((tile) => (
                <li><a class="bz-merch-tile" href={tile.url}><Image image={tile.image} sizes="140px" alt="" /><span>{tile.title}</span></a></li>
              ))}
            </ul>
            <a class="bz-link bz-merch-more" href={group[0]!.url}>{text(settings.link_label) ?? t(context, { en: "Shop now", bn: "এখনই কিনুন" })}</a>
          </article>
        ))}
      </div>
    </section>
  );
}

// ── Listing ──────────────────────────────────────────────────────────────

/** The results page: "1-48 of over N results", the filter rail on the left, the card grid and the page links. */
export function ListingPage({ data, context }: ListingMainProps<{ fast_label: string | null }>) {
  const perPage = Math.max(1, data.cards.length);
  const first = (data.page - 1) * perPage + 1;
  const last = first + data.cards.length - 1;
  const total = formatNumber(context, data.total);
  const range = data.cards.length > 0 ? `${formatNumber(context, first)}-${formatNumber(context, last)}` : formatNumber(context, 0);
  const summary = data.totalIsCapped
    ? t(context, { en: `${range} of over ${total} results`, bn: `${total}+ ফলাফলের মধ্যে ${range}` })
    : t(context, { en: `${range} of ${total} results`, bn: `${total}টি ফলাফলের মধ্যে ${range}` });
  return (
    <div class="bz-listing">
      <div class="bz-results-bar">
        <p>{summary}{data.kind === "search" && data.title ? <> {t(context, { en: "for", bn: "-" })} <strong class="bz-results-q">"{data.title}"</strong></> : null}</p>
        <div class="bz-results-sort"><Toolbar /></div>
      </div>
      <div class="bz-listing-body">
        <aside class="bz-filters" aria-label={t(context, { en: "Filters", bn: "ফিল্টার" })}><Filters /></aside>
        <div class="bz-results">
          <h1 class="bz-results-title">{data.kind === "search" ? t(context, { en: "Results", bn: "ফলাফল" }) : data.title}</h1>
          {data.cards.length > 0 ? (
            <ul class="bz-grid">{data.cards.map((product, index) => <li><ProductCard product={product} context={context} options={{ eager: index < 4 }} /></li>)}</ul>
          ) : <p class="bz-empty">{t(context, { en: "No results. Try checking your spelling or use more general terms.", bn: "কোনো ফলাফল নেই। বানান দেখুন বা সাধারণ শব্দ ব্যবহার করুন।" })}</p>}
          <div class="bz-pages"><Pagination /></div>
        </div>
      </div>
    </div>
  );
}
