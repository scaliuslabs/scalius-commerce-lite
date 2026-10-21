import type { PageDto } from "~/lib/api-query-options/pages";
import type { PageFormValues } from "~/lib/form-schemas";
import { getPagePublicationMode } from "~/lib/page-publication";
import { unixToDate } from "@scalius/shared/timestamps";

/** A stored instant of unknown form (ISO text or epoch seconds) as a Date. */
function storedInstant(value: unknown): Date | null {
  return typeof value === "string" || typeof value === "number" ? unixToDate(value) : null;
}
import { richTextOrEmpty } from "./rich-text-value";

export function toPageFormValues(page: PageDto): PageFormValues {
  return {
    id: page.id,
    revision: page.revision,
    contentType: page.contentType,
    title: page.title,
    slug: page.slug,
    content: richTextOrEmpty(page.content),
    excerpt: page.excerpt,
    author: page.author,
    tags: page.tags,
    metaTitle: page.metaTitle,
    metaDescription: page.metaDescription,
    canonicalPath: page.canonicalPath,
    noIndex: page.noIndex,
    excludeFromSitemap: page.excludeFromSitemap,
    publicationMode: getPagePublicationMode(page),
    publishedAt: unixToDate(page.publishedAt) ?? null,
    hideHeader: page.hideHeader,
    hideFooter: page.hideFooter,
    hideTitle: page.hideTitle,
    featuredImage: page.featuredImage
      ? {
          ...page.featuredImage,
          // The upload times ride along from Files; they are not part of the page contract.
          createdAt: storedInstant(page.featuredImage.createdAt) ?? new Date(0),
          updatedAt: storedInstant(page.featuredImage.updatedAt) ?? undefined,
        }
      : null,
  };
}
