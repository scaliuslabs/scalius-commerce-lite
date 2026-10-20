// Volt's skins of the store's own sections. The merchant fills the store's
// section (its slides, products, categories, facts); Volt draws it the way
// the source store does. A skin that has nothing to draw returns null, and
// the store draws its own section.

import { Image, Island, t, type SectionSkinProps, type StorefrontImage } from "@scalius/plugin-sdk/storefront";
import { Icon, factIcon } from "./icons";
import { CardGrid, Section, SectionHead, cx, list, text, whole, type Context } from "./ui";

// ── Hero: the slider at the start, two stacked banners at the end ─────────

interface HeroSettings {
  autoplay: boolean;
  interval: number;
}

function Slide({ image, phone, alt, link, eager }: { image: StorefrontImage; phone: StorefrontImage | null; alt: string; link: string | null; eager: boolean }) {
  const picture = (
    <span class="volt-slide-media">
      <Image image={{ ...image, alt: alt || image.alt }} class={cx(phone && "volt-desk-img")} loading={eager ? "eager" : "lazy"} sizes="(min-width: 64rem) 66vw, 100vw" />
      {phone ? <Image image={{ ...phone, alt: alt || phone.alt }} class="volt-phone-img" loading={eager ? "eager" : "lazy"} sizes="100vw" /> : null}
    </span>
  );
  return link ? <a class="volt-slide" href={link}>{picture}</a> : <div class="volt-slide">{picture}</div>;
}

export function HeroSkin({ settings, data, context }: SectionSkinProps<"hero", HeroSettings>) {
  const slides = list(data.settings.slides).filter((slide) => slide.image);
  if (slides.length === 0) return null;
  const banners = list(data.settings.sideBanners).filter((banner) => banner.image);
  const eager = data.aboveFold === true;
  return (
    <section class="volt-s volt-s-hero" aria-label={t(context, { en: "Featured offers", bn: "বিশেষ অফার" })}>
      <div class={cx("volt-wrap volt-hero", banners.length > 0 && "has-side")}>
        <Island name="slider" hydrate="visible" class="volt-slider" props={{ autoplay: settings.autoplay !== false && slides.length > 1, interval: whole(settings.interval, 3, 12, 5) }}>
          <div class="volt-slider-track" data-track>
            {slides.map((slide, index) => (
              <Slide image={slide.image!} phone={slide.phoneImage ?? null} alt={slide.alt} link={slide.link} eager={eager && index === 0} />
            ))}
          </div>
          {slides.length > 1 ? (
            <div class="volt-slider-ui">
              <button type="button" class="volt-slider-arrow is-prev" data-prev aria-label={t(context, { en: "Previous slide", bn: "আগের স্লাইড" })}><Icon name="back" size={20} /></button>
              <button type="button" class="volt-slider-arrow is-next" data-next aria-label={t(context, { en: "Next slide", bn: "পরের স্লাইড" })}><Icon name="chevron" size={20} /></button>
              <div class="volt-dots" data-dots>
                {slides.map((_, index) => <button type="button" class="volt-dot" data-dot={String(index)} aria-label={t(context, { en: `Slide ${index + 1}`, bn: `স্লাইড ${index + 1}` })} aria-current={index === 0 ? "true" : undefined} />)}
              </div>
            </div>
          ) : null}
        </Island>
        {banners.length > 0 ? (
          <div class="volt-hero-side">
            {banners.map((banner) => {
              const image = <Image image={{ ...banner.image!, alt: banner.alt || banner.image!.alt }} loading={eager ? "eager" : "lazy"} fetchpriority={eager ? "auto" : undefined} sizes="(min-width: 64rem) 33vw, 50vw" />;
              return banner.href ? <a class="volt-side-banner" href={banner.href}>{image}</a> : <div class="volt-side-banner">{image}</div>;
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ── Trust strip ───────────────────────────────────────────────────────────

export function TrustStrip({ items, context }: { items: Array<{ title: string; detail: string; icon?: string | null }>; context: Context }) {
  if (items.length === 0) return null;
  return (
    <section class="volt-s volt-s-trust" aria-label={t(context, { en: "Why shop with us", bn: "কেন আমাদের কাছ থেকে কিনবেন" })}>
      <ul class="volt-wrap volt-trust">
        {items.map((item) => (
          <li>
            <span class="volt-trust-icon"><Icon name={factIcon(item.icon || item.title)} size={26} /></span>
            <span><strong>{item.title}</strong>{item.detail ? <small>{item.detail}</small> : null}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UspSkin({ data, context }: SectionSkinProps<"usp-strip">) {
  return <TrustStrip items={list(data.settings?.source?.items)} context={context} />;
}

// ── Featured categories: small tiles in a dense grid, "See All" under it ──

interface TilesSettings {
  subtitle: string | null;
  all_label: string | null;
  all_link: string | null;
}

export function CategoryTilesSkin({ settings, data, context }: SectionSkinProps<"category-tiles", TilesSettings>) {
  const tiles = list(data.settings.categories);
  if (tiles.length === 0) return null;
  const all = text(settings.all_link);
  return (
    <Section name="categories">
      <SectionHead centered title={text(data.settings.title) ?? t(context, { en: "Featured Category", bn: "ফিচার্ড ক্যাটাগরি" })}
        subtitle={text(settings.subtitle) ?? t(context, { en: "Get your desired product from featured category!", bn: "ফিচার্ড ক্যাটাগরি থেকে আপনার পছন্দের পণ্যটি নিন!" })} />
      <ul class="volt-tiles">
        {tiles.map((tile) => (
          <li><a class="volt-tile" href={tile.url}>
            <span class="volt-tile-media">{tile.image ? <Image image={{ ...tile.image, alt: "" }} sizes="96px" /> : <Icon name="grid" size={32} />}</span>
            <span class="volt-tile-label">{tile.title}</span>
          </a></li>
        ))}
      </ul>
      {all ? <p class="volt-center"><a class="volt-btn is-line" href={all}>{text(settings.all_label) ?? t(context, { en: "See All Categories", bn: "সব ক্যাটাগরি দেখুন" })}</a></p> : null}
    </Section>
  );
}

// ── Product sections: tabs, grid, row, deals ──────────────────────────────

interface ProductsSettings {
  subtitle: string | null;
  link_label: string | null;
  columns: number;
}

export function ProductTabsSkin({ settings, data, context, instanceId }: SectionSkinProps<"product-tabs", ProductsSettings>) {
  const limit = whole(data.settings.limit, 4, 12, 8);
  const tabs = list(data.settings.tabs).filter((tab) => list(tab.products?.cards).length > 0);
  if (tabs.length === 0) return null;
  const columns = whole(settings.columns, 2, 6, 5);
  const id = `volt-tabs-${instanceId.replace(/[^a-z0-9_-]/gi, "").slice(0, 40)}`;
  return (
    <Section name="tabs">
      <Island name="tabs" hydrate="visible" class="volt-tabs">
        <SectionHead title={text(data.settings.title)} subtitle={text(settings.subtitle)}>
          {tabs.length > 1 ? (
            <div class="volt-tablist" role="tablist">
              {tabs.map((tab, index) => (
                <button type="button" role="tab" class="volt-tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
                  aria-selected={index === 0 ? "true" : "false"} tabindex={index === 0 ? undefined : "-1"} data-tab={String(index)}>{tab.label || tab.products.title}</button>
              ))}
            </div>
          ) : null}
        </SectionHead>
        {tabs.map((tab, index) => (
          <div class="volt-tab-panel" role="tabpanel" id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} data-panel={String(index)} data-active={index === 0 ? "" : undefined}>
            <h3 class="volt-tab-title">{tab.label || tab.products.title}</h3>
            <CardGrid cards={tab.products.cards.slice(0, limit)} context={context} columns={columns} eagerFirst={data.aboveFold && index === 0 ? columns : 0} />
            {text(settings.link_label) && tab.products.url ? <p class="volt-center"><a class="volt-btn is-line" href={tab.products.url}>{text(settings.link_label)}</a></p> : null}
          </div>
        ))}
      </Island>
    </Section>
  );
}

export function ProductGridSkin({ settings, data, context }: SectionSkinProps<"product-grid", ProductsSettings>) {
  const columns = whole(data.settings.columns, 2, 6, 5);
  const cards = list(data.settings.products?.cards).slice(0, columns * whole(data.settings.rows, 1, 6, 2));
  if (cards.length === 0) return null;
  return (
    <Section name="grid">
      <SectionHead title={text(data.settings.title) ?? data.settings.products?.title} subtitle={text(settings.subtitle)}
        link={data.settings.products?.url ?? null} linkLabel={text(settings.link_label)} />
      <CardGrid cards={cards} context={context} columns={columns} />
    </Section>
  );
}

export function ProductRailSkin({ settings, data, context }: SectionSkinProps<"product-rail", ProductsSettings>) {
  const cards = list(data.settings.products?.cards).slice(0, whole(data.settings.limit, 4, 24, 12));
  if (cards.length === 0) return null;
  return (
    <Section name="rail">
      <SectionHead title={text(data.settings.title) ?? data.settings.products?.title} subtitle={text(settings.subtitle)}
        link={data.settings.products?.url ?? null} linkLabel={text(settings.link_label)} />
      <CardGrid cards={cards} context={context} columns={whole(settings.columns, 2, 6, 5)} row />
    </Section>
  );
}

export function DealSkin({ settings, data, context }: SectionSkinProps<"deal-block", ProductsSettings>) {
  const cards = list(data.settings.products?.cards);
  if (cards.length === 0) return null;
  const image = data.settings.image ?? null;
  return (
    <Section name="deals">
      <SectionHead title={text(data.settings.title) ?? data.settings.products?.title} subtitle={text(settings.subtitle)}
        link={data.settings.products?.url ?? null} linkLabel={text(settings.link_label)} />
      <div class={cx("volt-deals", image && "has-banner")}>
        {image ? <a class="volt-deals-banner" href={data.settings.products?.url ?? "#"}><Image image={image} sizes="(min-width: 64rem) 25vw, 100vw" /></a> : null}
        <CardGrid cards={cards} context={context} columns={whole(settings.columns, 2, 6, image ? 4 : 5)} row={!!image} />
      </div>
    </Section>
  );
}

// ── Brands, banners, long text ────────────────────────────────────────────

export function BrandWallSkin({ data, context }: SectionSkinProps<"brand-wall">) {
  const tiles = list(data.tiles);
  if (tiles.length === 0) return null;
  return (
    <Section name="brands">
      <SectionHead title={text(data.settings.title) ?? t(context, { en: "Top Brands", bn: "সেরা ব্র্যান্ড" })} />
      <ul class={cx("volt-brands", data.settings.style === "rail" && "is-row")}>
        {tiles.map((tile) => (
          <li><a class="volt-brand" href={tile.url}>
            {tile.image ? <Image image={{ ...tile.image, alt: tile.title }} sizes="160px" /> : <span>{tile.title}</span>}
          </a></li>
        ))}
      </ul>
    </Section>
  );
}

export function BannerMosaicSkin({ data }: SectionSkinProps<"banner-mosaic">) {
  const tiles = list(data.settings.tiles).filter((tile) => tile.image);
  if (tiles.length === 0) return null;
  return (
    <Section name="banners">
      <div class="volt-banners" style={{ "--volt-banners": String(Math.min(tiles.length, 3)) }}>
        {tiles.map((tile) => {
          const image = <Image image={{ ...tile.image!, alt: tile.alt || tile.image!.alt }} sizes="(min-width: 64rem) 33vw, 100vw" />;
          return tile.href ? <a class="volt-banner" href={tile.href}>{image}</a> : <div class="volt-banner">{image}</div>;
        })}
      </div>
    </Section>
  );
}

export function SeoTextSkin({ data }: SectionSkinProps<"seo-text">) {
  const body = text(data.settings.body);
  if (!body) return null;
  return (
    <Section name="about">
      <div class="volt-about volt-prose">
        {text(data.settings.heading) ? <h2 class="volt-h2">{data.settings.heading}</h2> : null}
        {body.split(/\n{2,}/).map((paragraph) => {
          const lines = paragraph.split("\n");
          const head = lines[0]!.match(/^#{1,3}\s+(.*)$/);
          return head ? [<h3 class="volt-h3">{head[1]}</h3>, lines.length > 1 ? <p>{lines.slice(1).join(" ")}</p> : null] : <p>{lines.join(" ")}</p>;
        })}
      </div>
    </Section>
  );
}
