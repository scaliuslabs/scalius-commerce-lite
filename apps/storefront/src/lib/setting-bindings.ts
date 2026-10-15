import { parseBindingResourceSelector, type BindingResource, type SettingBindingContext } from "@scalius/shared/storefront-theme/bindings";
import type { HomepageMediaAsset } from "./api/storefront";

/** Normalize only the page part already in memory; no secondary public reads. */
export function resourceBindingContext(resource: unknown, url: string, images: readonly unknown[] = []): SettingBindingContext {
  if (!resource || typeof resource !== "object") return {};
  const row = resource as Record<string, unknown>;
  const ownImage = row.logo ?? row.featuredImage ?? images[0];
  const image = ownImage && typeof ownImage === "object" ? ownImage as Record<string, unknown> : null;
  const imageUrl = image?.url ?? row.imageUrl;
  const imageId = image?.mediaId ?? image?.id ?? row.imageMediaId ?? "binding-resource-image";
  const imageAsset = typeof imageUrl === "string" && typeof imageId === "string"
    ? { id: imageId, url: imageUrl, alt: typeof image?.alt === "string" ? image.alt : "", width: typeof image?.width === "number" ? image.width : null, height: typeof image?.height === "number" ? image.height : null }
    : undefined;
  const routeOwner = url.startsWith("/products/") ? "product" : url.startsWith("/categories/") ? "category" : url.startsWith("/collections/") ? "collection" : url.startsWith("/brands/") ? "brand" : "page";
  return { resourceSelector: parseBindingResourceSelector(`${routeOwner}:${row.id}`), resource: {
    title: row.title ?? row.name,
    description: row.description ?? row.content,
    image: imageAsset?.id,
    imageAsset,
    url: typeof row.canonicalPath === "string" && row.canonicalPath.startsWith("/") ? row.canonicalPath : url,
    customFields: Array.isArray(row.customFields) ? row.customFields as BindingResource["customFields"] : [],
  } };
}

export function bindingResourceMedia(resource: BindingResource | null | undefined): HomepageMediaAsset[] {
  return [...(resource?.imageAsset ? [resource.imageAsset] : []), ...(resource?.customFields ?? []).flatMap((field) => {
    const image = field.reference as (HomepageMediaAsset & { id: string; url: string }) | null | undefined;
    return field.type === "media_reference" && image?.id && image.url
      ? [{ id: image.id, url: image.url, alt: image.alt ?? "", width: image.width ?? null, height: image.height ?? null }]
      : [];
  })];
}
