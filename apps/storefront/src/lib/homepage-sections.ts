/**
 * The homepage section library's data rules: what each section shows from
 * the homepage read (one batch part; the API reads what
 * `homeSectionRequests` names), whether it has anything to show, which
 * section leads the page, and how consecutive banners share a row. A
 * section without data renders nothing: no placeholders, no zero states.
 */
import {
  HOME_COLLECTIONS_FALLBACK_LIMIT,
  HOME_DEAL_LIMIT,
  HOME_LOOKBOOK_LIMIT,
  homeSectionProductList,
  storefrontProductSourceKey,
  storefrontSectionRenderer,
  type StorefrontProductSource,
  type StorefrontSection,
  type StorefrontSectionOf,
} from "@scalius/shared/storefront-theme";
import type { CollectionWithProducts, Product } from "@/lib/api";
import type { HomepageData, HomepageMediaAsset, HomepageProductList } from "@/lib/api/storefront";
import type { DeliveryFact } from "@/lib/delivery-facts";
import { resolveHomepageHero, type ResolvedHomepageHero } from "@/lib/homepage-hero";

/** Everything the homepage sections draw from, looked up by source key and media id. */
export interface HomepageContent {
  hero: ResolvedHomepageHero;
  collections: CollectionWithProducts[];
  categoryRail: HomepageData["presentation"]["categoryRail"];
  deliveryFacts: DeliveryFact[];
  lists: ReadonlyMap<string, HomepageProductList>;
  media: ReadonlyMap<string, HomepageMediaAsset>;
}

export function homepageContent(
  data: Pick<HomepageData, "hero" | "collections" | "presentation" | "sections">,
  deliveryFacts: DeliveryFact[],
): HomepageContent {
  return {
    hero: resolveHomepageHero(data.hero),
    collections: data.collections ?? [],
    categoryRail: data.presentation.categoryRail,
    deliveryFacts,
    lists: new Map((data.sections?.lists ?? []).map((list) => [list.key, list])),
    media: new Map((data.sections?.media ?? []).map((asset) => [asset.id, asset])),
  };
}

/** Whether a homepage collection renders (a grid needs products or its featured product). */
export function collectionShowsProducts(collection: CollectionWithProducts): boolean {
  const products = collection.products?.length ?? 0;
  if (collection.presentation === "carousel") return products > 0;
  if (collection.presentation === "grid") return products > 0 || Boolean(collection.featuredProduct);
  return false;
}

/** A plain-text body as paragraphs: blank lines separate them. */
export function richTextParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * Long SEO copy as blocks (Star Tech's h2 + paragraph pairs): a paragraph
 * whose first line starts with "## " opens with that line as a subheading.
 */
export function seoTextBlocks(body: string): Array<{ heading: string | null; text: string }> {
  return richTextParagraphs(body).map((paragraph) => {
    const [first = "", ...rest] = paragraph.split("\n");
    if (!/^##(\s|$)/.test(first)) return { heading: null, text: paragraph };
    return { heading: first.slice(2).trim() || null, text: rest.join("\n").trim() };
  }).filter((block) => block.heading || block.text);
}

/** A product list as a section shows it: its cards, title and "View all" link. */
export interface HomepageSectionProducts {
  products: Product[];
  /** The merchant's title, else one that says what the list is. */
  title: string;
  /** Where the whole list lives, when a listing shows it. */
  href: string | null;
}

const SOURCE_TITLES: Record<"newest" | "on-sale" | "popular", string> = {
  newest: "New arrivals",
  "on-sale": "On sale",
  popular: "Popular right now",
};

function sourceTitleAndHref(
  source: StorefrontProductSource,
  list: HomepageProductList | undefined,
): { title: string; href: string | null } | null {
  switch (source.kind) {
    case "newest":
      return { title: SOURCE_TITLES.newest, href: "/search" };
    case "on-sale":
      return { title: SOURCE_TITLES["on-sale"], href: "/search?hasDiscount=true" };
    // No listing sorts by popularity, so the list has no "View all".
    case "popular":
      return { title: SOURCE_TITLES.popular, href: null };
    case "collection":
      return list?.collection
        ? { title: list.collection.title, href: `/collections/${encodeURIComponent(list.collection.id)}` }
        : null;
    case "category":
      return list?.category
        ? {
            title: list.category.name,
            href: list.category.canonicalPath || `/categories/${encodeURIComponent(list.category.slug)}`,
          }
        : null;
  }
}

/** Products a section shows from its source (its first N), or null when it has none. */
export function homepageSectionProducts(
  section: StorefrontSection,
  content: HomepageContent,
): HomepageSectionProducts | null {
  const request = homeSectionProductList(section);
  if (!request || section.type === "collections") return null;
  const list = content.lists.get(storefrontProductSourceKey(request.source));
  const named = sourceTitleAndHref(request.source, list);
  const products = (list?.products ?? []).slice(0, request.limit) as Product[];
  if (!named || products.length === 0) return null;
  const title = "title" in section.settings ? section.settings.title.trim() : "";
  return { products, title: title || named.title, href: named.href };
}

/** The newest products a collections section shows when the store has no homepage collection. */
export function homepageCollectionsFallback(content: HomepageContent): Product[] {
  if (content.collections.length > 0) return [];
  return (content.lists.get("newest")?.products ?? []).slice(0, HOME_COLLECTIONS_FALLBACK_LIMIT) as Product[];
}

export function homepageMedia(content: HomepageContent, id: string | null | undefined): HomepageMediaAsset | null {
  return id ? content.media.get(id) ?? null : null;
}

/** A deal's end time when it is still ahead: a countdown only ever counts to a real end. */
export function dealEndsAt(section: StorefrontSectionOf<"deal-block">, now = Date.now()): string | null {
  const endsAt = section.settings.endsAt;
  return endsAt && Date.parse(endsAt) > now ? endsAt : null;
}

export { HOME_DEAL_LIMIT, HOME_LOOKBOOK_LIMIT };

function textPresent(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => Boolean(value?.trim()));
}

/** Whether a section has anything to show on this store (sections without data render nothing). */
export function homepageSectionRenders(section: StorefrontSection, content: HomepageContent): boolean {
  if (storefrontSectionRenderer(section) === null) return false;
  switch (section.type) {
    case "hero":
      return content.hero.desktop.length > 0 || content.hero.mobile.length > 0;
    case "usp-strip":
      return section.settings.source.kind === "delivery-facts"
        ? content.deliveryFacts.length > 0
        : section.settings.source.items.length > 0;
    case "category-tiles": {
      const count = content.categoryRail.enabled ? content.categoryRail.categories.length : 0;
      // Photo tiles are today's rail (one category is enough there); the
      // denser styles need two to be a choice at all.
      return section.settings.style === "photo" ? count > 0 : count >= 2;
    }
    case "collections":
      return content.collections.some(collectionShowsProducts) || homepageCollectionsFallback(content).length > 0;
    case "product-rail":
    case "product-grid":
    case "deal-block":
    case "lookbook":
    case "endless-grid":
      return homepageSectionProducts(section, content) !== null;
    case "banner":
      return homepageMedia(content, section.settings.mediaId) !== null
        || textPresent(section.settings.heading, section.settings.text);
    case "editorial":
      switch (section.settings.layout) {
        case "rich-text":
          return textPresent(section.settings.heading) || richTextParagraphs(section.settings.body).length > 0;
        case "image-with-text":
          return homepageMedia(content, section.settings.mediaId) !== null
            || textPresent(section.settings.heading, section.settings.body);
        case "multicolumn":
          return section.settings.columns.some((column) => textPresent(column.title, column.text));
        case "testimonial":
          return section.settings.quotes.length > 0;
        default:
          return false;
      }
    case "faq":
      return section.settings.items.length > 0;
    case "utility-cards":
      return section.settings.cards.length > 0;
    case "seo-text":
      return seoTextBlocks(section.settings.body).length > 0;
    default:
      return false;
  }
}

/**
 * Whether the section opens with a large photo that can be the page's
 * largest paint. Text strips, category thumbnails and the FAQ sit above
 * such a photo without pushing it below the fold, so they never lead.
 */
function leadsWithPhoto(section: StorefrontSection, content: HomepageContent): boolean {
  switch (section.type) {
    case "hero":
    case "collections":
    case "product-rail":
    case "product-grid":
    case "deal-block":
    case "lookbook":
    case "endless-grid":
      return true;
    case "banner":
      return homepageMedia(content, section.settings.mediaId) !== null;
    case "editorial":
      return section.settings.layout === "image-with-text" && homepageMedia(content, section.settings.mediaId) !== null;
    default:
      return false;
  }
}

/**
 * The section holding the first large photo buyers see. Only a leading hero
 * is preloaded; a leading product list or banner loads its first photos
 * eagerly instead. Sections without data never lead.
 */
export function homepageLeadSection(
  sections: readonly StorefrontSection[],
  content: HomepageContent,
): StorefrontSection | null {
  return sections.find((section) => leadsWithPhoto(section, content) && homepageSectionRenders(section, content)) ?? null;
}

/** What renders, in order: one entry per section, consecutive two-up / four-up banners in one row. */
export type HomepageRenderUnit =
  | { kind: "section"; section: StorefrontSection }
  | { kind: "banners"; layout: "two-up" | "four-up"; sections: Array<StorefrontSectionOf<"banner">> };

export function homepageRenderUnits(
  sections: readonly StorefrontSection[],
  content: HomepageContent,
): HomepageRenderUnit[] {
  const units: HomepageRenderUnit[] = [];
  for (const section of sections) {
    if (!homepageSectionRenders(section, content)) continue;
    if (section.type === "banner" && section.settings.layout !== "full") {
      const last = units.at(-1);
      const size = section.settings.layout === "two-up" ? 2 : 4;
      if (last?.kind === "banners" && last.layout === section.settings.layout && last.sections.length < size) {
        last.sections.push(section);
      } else {
        units.push({ kind: "banners", layout: section.settings.layout, sections: [section] });
      }
      continue;
    }
    units.push({ kind: "section", section });
  }
  return units;
}
