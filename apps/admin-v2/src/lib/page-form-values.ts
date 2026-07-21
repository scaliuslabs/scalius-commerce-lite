import type { PageDto } from "~/lib/api-functions/pages";
import type { PageFormValues } from "~/lib/form-schemas";
import { getPagePublicationMode } from "~/lib/page-publication";
import { unixToDate } from "@scalius/shared/timestamps";

export function toPageFormValues(page: PageDto): PageFormValues {
  return {
    id: page.id,
    revision: page.revision,
    contentType: page.contentType,
    title: page.title,
    slug: page.slug,
    content: page.content,
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
          createdAt: unixToDate(page.featuredImage.createdAt) ?? new Date(0),
          updatedAt: unixToDate(page.featuredImage.updatedAt) ?? undefined,
        }
      : null,
  };
}
