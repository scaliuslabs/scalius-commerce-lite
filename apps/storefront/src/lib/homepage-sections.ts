import type { StorefrontSection } from "@scalius/shared/storefront-theme";
import type { CollectionWithProducts } from "@/lib/api";

/** Whether a homepage collection renders (collection1/collection2 skip empty ones). */
export function collectionShowsProducts(collection: CollectionWithProducts): boolean {
  const products = collection.products?.length ?? 0;
  if (collection.presentation === "carousel") return products > 0;
  if (collection.presentation === "grid") return products > 0 || Boolean(collection.featuredProduct);
  return false;
}

/** Whether each theme block has anything to show for this store. */
export interface HomepageBlockContent {
  hero: boolean;
  collections: boolean;
  categories: boolean;
  delivery: boolean;
}

/** A rich text body as paragraphs: blank lines separate them. */
export function richTextParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function homepageSectionRenders(section: StorefrontSection, content: HomepageBlockContent): boolean {
  if (section.type === "rich_text") {
    return Boolean(section.settings.heading.trim()) || richTextParagraphs(section.settings.body).length > 0;
  }
  return content[section.type];
}

/** Sections whose photos can be the page's largest paint (LCP). */
const IMAGE_LEAD_TYPES = new Set<StorefrontSection["type"]>(["hero", "collections"]);

/**
 * The section holding the first large photo buyers see. Short text strips
 * (delivery facts, rich text) and the small category thumbnails sit above it
 * without pushing it below the fold, so they are skipped. The hero banner is
 * preloaded (and gets high fetch priority) only when it leads; a leading
 * product grid loads its first row eagerly instead. Empty sections render
 * nothing, so they never lead.
 */
export function homepageLeadSection(
  sections: readonly StorefrontSection[],
  content: HomepageBlockContent,
): StorefrontSection | null {
  return sections.find(
    (section) => IMAGE_LEAD_TYPES.has(section.type) && homepageSectionRenders(section, content),
  ) ?? null;
}
