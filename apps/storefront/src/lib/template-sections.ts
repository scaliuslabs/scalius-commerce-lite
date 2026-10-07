/**
 * A page template's section data for this request: the live part the page
 * started beside its layout read (one batch), or, under a theme preview,
 * the draft's on the private preview read. A template whose sections are
 * all hidden or unfit needs nothing.
 */
import type { StorefrontPageTemplate } from "@scalius/shared/storefront-theme";
import { getThemePreviewHomepageSections, type HomepageSectionData } from "@/lib/api/storefront";
import { getRuntimePresence } from "@/lib/api/runtime";
import type { RequestTheme } from "@/lib/storefront-theme-context";

export async function templateSectionData(
  kind: StorefrontPageTemplate,
  requestTheme: RequestTheme,
  live: Promise<HomepageSectionData | null>,
): Promise<HomepageSectionData | null> {
  // A template without sections to show reads nothing (a preview still marks its empty regions).
  if (requestTheme.resolved.pages.templates[kind].sections.length === 0) return null;
  if (requestTheme.preview && requestTheme.previewToken) {
    return getThemePreviewHomepageSections(requestTheme.previewToken, { template: kind, presence: getRuntimePresence() });
  }
  return live;
}
