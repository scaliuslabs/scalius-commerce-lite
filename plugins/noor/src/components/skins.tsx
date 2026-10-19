// Noor's skins of the store's own sections. A skin draws a core section from
// the section's own data (its slides, products, categories, questions), so
// the merchant fills the store's section and Noor only gives it its look; the
// few things core has no field for (an eyebrow, a tone, a countdown button)
// are the skin's own settings. Each adapter maps that data onto the markup
// components in ./sections, which keep Noor's HTML exactly as it was when
// these were sections of Noor's own (skins.parity.test.tsx holds that).
//
// A skin that draws nothing (a hero without a photo, an editorial layout it
// does not know) leaves the section to the store's own renderer.

import type {
  SectionSkinProps,
  StorefrontImage,
  StorefrontProductCard,
  StorefrontProductList,
  StorefrontRenderContext,
} from "@scalius/plugin-sdk/storefront";
import type { IconName } from "./icons";
import { Section, text } from "./ui";
import { Hero, Slideshow } from "./sections/hero";
import { CollectionTiles, ProductShowcase, PromoCountdown, PromoTiles, ShopTheLook } from "./sections/commerce";
import { Faq, Promises, RichText, SignupCall, Story } from "./sections/content";

/** The tone and spacing every Noor section shell takes. */
interface Shell {
  tone: string;
  spacing: string;
}

const none = (value: string | null | undefined): string | null => value ?? null;
const listOf = <Item,>(value: Item[] | null | undefined): Item[] => (Array.isArray(value) ? value : []);

/** A product list's cards, at most `limit`. */
const cardsOf = (list: StorefrontProductList | undefined, limit: number): StorefrontProductCard[] => listOf(list?.cards).slice(0, limit);

/** A product list's "view all" link when the merchant gave a link text but no link of its own. */
function listLink(link: string | null, label: string | null, list: StorefrontProductList | undefined): string | null {
  return text(link) ?? (text(label) ? list?.url ?? null : null);
}

// ── Hero ─────────────────────────────────────────────────────────────────

interface HeroSkinSettings extends Shell {
  eyebrow: string | null;
  secondary_label: string | null;
  secondary_link: string | null;
  layout: string;
  position: string;
  height: string;
  scrim: string;
  autoplay: boolean;
  interval: number;
}

/** One slide: its photo (the slide's alt text describes it), words and button. One slide is a hero, several a slideshow. */
export function HeroSkin({ settings, data, context, instanceId }: SectionSkinProps<"hero", HeroSkinSettings>) {
  const photo = (image: StorefrontImage | null | undefined, alt: string): StorefrontImage | null => (image ? { ...image, alt: alt || image.alt } : null);
  const slides = listOf(data.settings.slides).filter((slide) => slide.image || slide.phoneImage);
  if (slides.length === 0) return null;
  if (slides.length > 1) {
    return (
      <Slideshow objects={{}} instanceId={instanceId} context={context} settings={{
        slides: slides.map((slide) => ({
          image: photo(slide.image, slide.alt),
          phone_image: photo(slide.phoneImage, slide.alt),
          eyebrow: null,
          heading: none(slide.heading),
          text: none(slide.text),
          label: none(slide.buttonLabel),
          link: slide.link,
          position: settings.position,
        })),
        autoplay: settings.autoplay,
        interval: settings.interval,
        height: settings.height,
        scrim: settings.scrim,
      }} />
    );
  }
  const slide = slides[0]!;
  return (
    <Hero objects={{}} instanceId={instanceId} context={context} settings={{
      eyebrow: settings.eyebrow,
      heading: none(slide.heading),
      text: none(slide.text),
      image: photo(slide.image, slide.alt),
      phone_image: photo(slide.phoneImage, slide.alt),
      primary_label: none(slide.buttonLabel),
      primary_link: slide.link,
      secondary_label: settings.secondary_label,
      secondary_link: settings.secondary_link,
      layout: settings.layout,
      position: settings.position,
      height: settings.height,
      scrim: settings.scrim,
      tone: settings.tone,
    }} />
  );
}

// ── Products ─────────────────────────────────────────────────────────────

interface ProductsSkinSettings extends Shell {
  eyebrow: string | null;
  text: string | null;
  link: string | null;
  link_label: string | null;
  layout: string;
  columns: number;
}

function Showcase({ settings, heading, tabs, link, layout, context, instanceId, eager }: {
  settings: ProductsSkinSettings;
  heading: string;
  tabs: Array<{ label: string | null; products: StorefrontProductCard[] }>;
  link: string | null;
  layout: string;
  context: StorefrontRenderContext;
  instanceId: string;
  eager: boolean;
}) {
  return (
    <ProductShowcase objects={{}} instanceId={instanceId} context={context} settings={{
      eyebrow: settings.eyebrow,
      heading: none(heading),
      text: settings.text,
      link,
      link_label: settings.link_label,
      tabs,
      layout,
      columns: settings.columns,
      tone: settings.tone,
      spacing: settings.spacing,
      eager,
    }} />
  );
}

/** Tabs: each core tab is a tab here, its products the tab's list. */
export function ProductTabsSkin({ settings, data, context, instanceId }: SectionSkinProps<"product-tabs", ProductsSkinSettings>) {
  const tabs = listOf(data.settings.tabs);
  const { title, limit = 8 } = data.settings;
  return (
    <Showcase settings={settings} heading={title} context={context} instanceId={instanceId} layout={settings.layout} eager={data.aboveFold === true}
      link={listLink(settings.link, settings.link_label, tabs[0]?.products)}
      tabs={tabs.map((tab) => ({ label: tab.label, products: cardsOf(tab.products, limit) }))} />
  );
}

/** A grid: the core grid's columns and rows. */
export function ProductGridSkin({ settings, data, context, instanceId }: SectionSkinProps<"product-grid", ProductsSkinSettings>) {
  const { title, products: source, columns = 4, rows = 2 } = data.settings;
  return (
    <ProductShowcase objects={{}} instanceId={instanceId} context={context} settings={{
      eyebrow: settings.eyebrow,
      heading: none(title),
      text: settings.text,
      link: listLink(settings.link, settings.link_label, source),
      link_label: settings.link_label,
      tabs: [{ label: null, products: cardsOf(source, columns * rows) }],
      layout: "grid",
      columns,
      tone: settings.tone,
      spacing: settings.spacing,
      eager: data.aboveFold === true,
    }} />
  );
}

/** A scrolling row. */
export function ProductRailSkin({ settings, data, context, instanceId }: SectionSkinProps<"product-rail", ProductsSkinSettings>) {
  const { title, products: source, limit = 12 } = data.settings;
  return (
    <Showcase settings={settings} heading={title} context={context} instanceId={instanceId} layout="row" eager={data.aboveFold === true}
      link={listLink(settings.link, settings.link_label, source)}
      tabs={[{ label: null, products: cardsOf(source, limit) }]} />
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────

interface TilesSkinSettings extends Shell {
  eyebrow: string | null;
  link: string | null;
  link_label: string | null;
  layout: string;
}

function Tiles({ settings, heading, tiles, context, instanceId }: {
  settings: TilesSkinSettings;
  heading: string;
  tiles: Array<{ image: StorefrontImage | null; title: string | null; subtitle?: string | null; link: string | null }>;
  context: StorefrontRenderContext;
  instanceId: string;
}) {
  return (
    <CollectionTiles objects={{}} instanceId={instanceId} context={context} settings={{
      eyebrow: settings.eyebrow,
      heading: none(heading),
      link: settings.link,
      link_label: settings.link_label,
      tiles: tiles.map((tile) => ({ ...tile, subtitle: tile.subtitle ?? null })),
      layout: settings.layout,
      tone: settings.tone,
      spacing: settings.spacing,
    }} />
  );
}

/** The merchant's categories as photo tiles (a category without a photo is left out). */
export function CategoryTilesSkin({ settings, data, context, instanceId }: SectionSkinProps<"category-tiles", TilesSkinSettings>) {
  return (
    <Tiles settings={settings} heading={data.settings.title} context={context} instanceId={instanceId}
      tiles={listOf(data.settings.categories).map((tile) => ({ image: tile.image, title: tile.title, link: tile.url }))} />
  );
}

/** "Shop by" cards (a photo, a label and a link each) as photo tiles. */
export function ShopByTilesSkin({ settings, data, context, instanceId }: SectionSkinProps<"shop-by", TilesSkinSettings>) {
  return (
    <Tiles settings={settings} heading={data.settings.title} context={context} instanceId={instanceId}
      tiles={listOf(data.settings.cards).map((card) => ({ image: card.image, title: card.title, subtitle: card.subtitle, link: card.href }))} />
  );
}

interface PromoSkinSettings extends Shell {
  height: string;
}

/** The banner mosaic's photos as large promo tiles; a tile's alt text is its heading. */
export function PromoTilesSkin({ settings, data, context, instanceId }: SectionSkinProps<"banner-mosaic", PromoSkinSettings>) {
  return (
    <PromoTiles objects={{}} instanceId={instanceId} context={context} settings={{
      items: listOf(data.settings.tiles).slice(0, 3).map((tile) => ({ image: tile.image, eyebrow: null, heading: text(tile.alt), label: null, link: tile.href })),
      height: settings.height,
      tone: settings.tone,
      spacing: settings.spacing,
    }} />
  );
}

// ── Shop the look ────────────────────────────────────────────────────────

interface LookSkinSettings extends Shell {
  eyebrow: string | null;
  text: string | null;
  hotspots: Array<{ x: number | null; y: number | null; title: string | null; text: string | null; link: string | null }>;
  image_side: string;
}

/** A lookbook's photo with Noor's numbered points, beside its products. */
export function LookSkin({ settings, data, context, instanceId }: SectionSkinProps<"lookbook", LookSkinSettings>) {
  const { title, image, products: source } = data.settings;
  return (
    <ShopTheLook objects={{}} instanceId={instanceId} context={context} settings={{
      eyebrow: settings.eyebrow,
      heading: none(title),
      text: settings.text,
      image,
      hotspots: listOf(settings.hotspots),
      products: cardsOf(source, 4),
      image_side: settings.image_side,
      tone: settings.tone,
      spacing: settings.spacing,
    }} />
  );
}

// ── Sale banner ──────────────────────────────────────────────────────────

interface SaleSkinSettings extends Shell {
  eyebrow: string | null;
  text: string | null;
  label: string | null;
  link: string | null;
}

/** A deal block as a banner counting down to its promotion's end, then its products in a row. */
export function SaleSkin({ settings, data, context, instanceId }: SectionSkinProps<"deal-block", SaleSkinSettings>) {
  const { title, products: source, promotion } = data.settings;
  const end = promotion ? Date.parse(promotion.endsAt) : Number.NaN;
  const products = listOf(source?.cards);
  return (
    <>
      <PromoCountdown objects={{}} instanceId={instanceId} context={context} settings={{
        image: data.settings.image ?? null,
        eyebrow: settings.eyebrow,
        heading: none(title),
        text: settings.text,
        end: Number.isFinite(end) ? end : null,
        label: settings.label,
        link: listLink(settings.link, settings.label, source),
        tone: settings.tone,
        spacing: settings.spacing,
      }} />
      {products.length > 0 ? (
        <ProductShowcase objects={{}} instanceId={`${instanceId}-products`} context={context} settings={{
          eyebrow: null, heading: null, text: null, link: null, link_label: null,
          tabs: [{ label: null, products }], layout: "row", columns: 4, tone: "plain", spacing: "s",
        }} />
      ) : null}
    </>
  );
}

// ── Promises ─────────────────────────────────────────────────────────────

interface PromisesSkinSettings extends Shell {
  eyebrow: string | null;
  heading: string | null;
  style: string;
}

const ICON_WORDS: Array<[RegExp, IconName]> = [
  [/cash|\bcod\b|ক্যাশ/i, "cash"],
  [/deliver|shipping|courier|ডেলিভারি|শিপিং/i, "truck"],
  [/return|exchange|refund|রিটার্ন|ফেরত/i, "returns"],
  [/warrant|guarant|secure|genuine|authentic|ওয়ারেন্টি/i, "shield"],
  [/support|help|chat|contact|সহায়তা/i, "chat"],
  [/gift/i, "gift"],
  [/quality|certified|badge/i, "badge"],
];

/** Noor's icon for a promise, from what its title says (the store's section carries no icons). */
function promiseIcon(title: string): IconName {
  return ICON_WORDS.find(([pattern]) => pattern.test(title))?.[1] ?? "check";
}

/** The store's delivery facts or the merchant's own points as Noor's icon promises. */
export function PromisesSkin({ settings, data, context, instanceId }: SectionSkinProps<"usp-strip", PromisesSkinSettings>) {
  return (
    <Promises objects={{}} instanceId={instanceId} context={context} settings={{
      eyebrow: settings.eyebrow,
      heading: settings.heading,
      items: listOf(data.settings.source?.items).map((item) => ({ icon: promiseIcon(item.title), title: item.title, text: none(item.detail) })),
      style: settings.style,
      tone: settings.tone,
      spacing: settings.spacing,
    }} />
  );
}

// ── Editorial and text ───────────────────────────────────────────────────

interface StorySkinSettings extends Shell {
  eyebrow: string | null;
  points: Array<{ text: string | null }>;
  stats: Array<{ value: string | null; label: string | null }>;
  cta_label: string | null;
  cta_link: string | null;
  align: string;
  size: string;
}

/** An editorial section's rich text or image-with-text layout; other layouts stay the store's. */
export function StorySkin({ settings, data, context, instanceId }: SectionSkinProps<"editorial", StorySkinSettings>) {
  const section = data.settings;
  if (section.layout === "rich-text") {
    return (
      <RichText objects={{}} instanceId={instanceId} context={context} settings={{
        eyebrow: settings.eyebrow, heading: none(section.heading), text: section.body,
        cta_label: settings.cta_label, cta_link: settings.cta_link, align: settings.align, size: settings.size,
        tone: settings.tone, spacing: settings.spacing,
      }} />
    );
  }
  if (section.layout === "image-with-text") {
    return (
      <Story objects={{}} instanceId={instanceId} context={context} settings={{
        eyebrow: settings.eyebrow, heading: none(section.heading), text: section.body, image: section.image, image_side: section.imageSide,
        points: listOf(settings.points), stats: listOf(settings.stats),
        cta_label: settings.cta_label, cta_link: settings.cta_link, tone: settings.tone, spacing: settings.spacing,
      }} />
    );
  }
  return null;
}

/** Long text below the page as Noor's text block. */
export function TextSkin({ settings, data, context, instanceId }: SectionSkinProps<"seo-text", StorySkinSettings>) {
  return (
    <RichText objects={{}} instanceId={instanceId} context={context} settings={{
      eyebrow: settings.eyebrow, heading: none(data.settings.heading), text: data.settings.body,
      cta_label: settings.cta_label, cta_link: settings.cta_link, align: settings.align, size: settings.size,
      tone: settings.tone, spacing: settings.spacing,
    }} />
  );
}

// ── Questions and sign-up ────────────────────────────────────────────────

interface FaqSkinSettings extends Shell {
  eyebrow: string | null;
  text: string | null;
  contact_label: string | null;
  contact_link: string | null;
  structured_data: boolean;
}

/** The store's questions as Noor's accordion, with FAQ markup unless turned off. */
export function FaqSkin({ settings, data, context, instanceId }: SectionSkinProps<"faq", FaqSkinSettings>) {
  return (
    <Faq objects={{}} instanceId={instanceId} context={context} settings={{
      eyebrow: settings.eyebrow,
      heading: none(data.settings.heading),
      text: settings.text,
      questions: listOf(data.settings.items).map((item) => ({ question: item.question, answer: item.answer })),
      contact_label: settings.contact_label,
      contact_link: settings.contact_link,
      structured_data: settings.structured_data,
      tone: settings.tone,
      spacing: settings.spacing,
    }} />
  );
}

interface SignupSkinSettings extends Shell {
  eyebrow: string | null;
  button: string | null;
  link: string | null;
}

/** The newsletter section as Noor's call to join, linking to the store's sign-up page. */
export function SignupSkin({ settings, data, context, instanceId }: SectionSkinProps<"newsletter", SignupSkinSettings>) {
  return (
    <SignupCall objects={{}} instanceId={instanceId} context={context} settings={{
      image: data.settings.image ?? null,
      eyebrow: settings.eyebrow,
      heading: none(data.settings.heading),
      text: none(data.settings.text),
      button: text(data.settings.buttonLabel) ?? settings.button,
      link: settings.link,
      tone: settings.tone,
      spacing: settings.spacing,
    }} />
  );
}

/** Specifications use the same resolved custom-field values as the core section. */
export function SpecificationsSkin({ settings, data }: SectionSkinProps<"specifications", Shell>) {
  const rows = listOf(data.settings.rows).filter((row) => text(row.label) && text(row.value));
  const fields = data.settings.objectFields ?? [];
  if (!rows.length && !fields.length) return null;
  return <Section name="specifications" tone={settings.tone} space={settings.spacing}>
    {text(data.settings.heading) ? <h2 class="noor-h2">{data.settings.heading}</h2> : null}
    <dl class="noor-specifications">{fields.length ? fields.map((field) => <div>
      <dt>{field.name}</dt>
      <dd>{field.parts.map((part, index) => <span>
        {index > 0 ? ", " : null}
        {part.kind === "text" ? part.text : null}
        {part.kind === "link" ? <a href={part.href} target={part.external ? "_blank" : undefined} rel={part.external ? "noopener noreferrer" : undefined}>{part.label}</a> : null}
        {part.kind === "color" ? part.value : null}
        {part.kind === "image" ? <img src={part.asset.url} alt={part.asset.alt || data.settings.heading} width={part.asset.width ?? 480} height={part.asset.height ?? 480} loading="lazy" /> : null}
      </span>)}</dd>
    </div>) : rows.map((row) => <div><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
  </Section>;
}
