import type {
  CreatePageInput,
  PageFeaturedImageDto,
  UpdatePageInput,
} from "./api-functions/pages";
import type { PageFormValues } from "./form-schemas";
import { publicationFieldsForInput } from "./page-publication";

function serializeDate(
  value: Date | string | number | undefined,
): string | number | undefined {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeFeaturedImage(
  image: PageFormValues["featuredImage"],
): PageFeaturedImageDto | null {
  if (!image) return null;
  return {
    ...image,
    createdAt: serializeDate(image.createdAt),
    updatedAt: serializeDate(image.updatedAt),
  };
}

function commonPageInput(values: PageFormValues) {
  const publication = publicationFieldsForInput({
    mode: values.publicationMode,
    publishedAt: values.publishedAt,
  });

  return {
    title: values.title,
    slug: values.slug,
    content: values.content,
    metaTitle: values.metaTitle,
    metaDescription: values.metaDescription,
    canonicalPath: values.canonicalPath,
    noIndex: values.noIndex,
    excludeFromSitemap: values.excludeFromSitemap,
    ...publication,
    hideHeader: values.hideHeader,
    hideFooter: values.hideFooter,
    hideTitle: values.hideTitle,
    featuredImage: serializeFeaturedImage(values.featuredImage),
  };
}

export function toCreatePageInput(values: PageFormValues): CreatePageInput {
  return {
    contentType: values.contentType,
    ...commonPageInput(values),
    excerpt: values.contentType === "article" ? values.excerpt : null,
    author: values.contentType === "article" ? values.author : null,
    tags: values.contentType === "article" ? values.tags : [],
  };
}

export function toUpdatePageInput(
  values: PageFormValues,
): Omit<UpdatePageInput, "id" | "expectedRevision"> {
  return {
    ...commonPageInput(values),
    ...(values.contentType === "article"
      ? {
          excerpt: values.excerpt,
          author: values.author,
          tags: values.tags,
        }
      : {}),
  };
}
