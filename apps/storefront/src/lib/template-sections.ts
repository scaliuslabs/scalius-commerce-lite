/**
 * A page template's section data for this request. A template without
 * sections to show reads nothing: the page's one batch stays as it was (a
 * store that never adds template sections pays nothing). A template with
 * sections reads them once the theme is known: the published part, or under
 * a theme preview the draft's on the private preview read.
 */
import type { StorefrontPageTemplate } from "@scalius/shared/storefront-theme";
import { collectObjectBindingTypes } from "@scalius/shared/storefront-theme/bindings";
import { getTemplateSectionsData } from "@/lib/api/pages";
import { getThemePreviewHomepageSections, type HomepageSectionData } from "@/lib/api/storefront";
import { getRuntimePresence } from "@/lib/api/runtime";
import type { RequestTheme } from "@/lib/storefront-theme-context";
import { applyRequestThemeBindings } from "@/lib/storefront-theme-context";

export async function templateSectionData(kind: StorefrontPageTemplate, requestTheme: RequestTheme): Promise<HomepageSectionData | null> {
  if (requestTheme.resolved.pages.templates[kind].sections.length === 0 && collectObjectBindingTypes(requestTheme.theme).length === 0) return null;
  const resource = requestTheme.bindingContext.resourceSelector;
  const needsResource = requestTheme.theme.pages.templates[kind].sections.some((section) => section.type === "app" && Object.values(section.bindings ?? {}).some((binding) => binding.source.startsWith("resource.cf.")));
  const resourceKey = needsResource && resource ? `${resource.ownerType}:${resource.id}` : undefined;
  const data = requestTheme.preview && requestTheme.previewToken
    ? await getThemePreviewHomepageSections(requestTheme.previewToken, { template: kind, presence: getRuntimePresence(), resource: resourceKey })
    : await getTemplateSectionsData(kind, resourceKey);
  if (data?.bindingObjects) applyRequestThemeBindings(requestTheme, { objects: data.bindingObjects, mediaIds: new Set(data.media.map((asset) => asset.id)) });
  return data;
}
