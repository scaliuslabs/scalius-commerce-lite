/**
 * Ready-made landing pages installed apps offer (`storefront.pagePresets`):
 * the "New landing page" dialog starts a page from one, and fills each of its
 * app sections' `product` settings with the product the merchant picks there,
 * so a campaign page for one product takes a title, a product and one click.
 */
import type { StorefrontSection } from "@scalius/shared/storefront-theme";
import type { ThemeApp } from "~/lib/api-query-options/online-store";

export interface LandingPreset {
  key: string;
  name: string;
  description: string | null;
  appName: string;
  sections: StorefrontSection[];
  /** Whether a section of it shows a picked product (the dialog then asks for one). */
  needsProduct: boolean;
}

/** The app section setting keys of type `product`, by app section key (`<app id>/<type>`). */
function productKeys(apps: readonly ThemeApp[]): Map<string, string[]> {
  return new Map(apps.flatMap((app) => app.sections.map((section) => [
    section.key,
    section.settings.filter((field) => field.type === "product").map((field) => field.key),
  ] as const)));
}

function appKey(section: StorefrontSection): string | null {
  return section.type === "app" ? section.settings.app : null;
}

export function landingPresets(apps: readonly ThemeApp[]): LandingPreset[] {
  const keys = productKeys(apps);
  return apps.flatMap((app) => app.pagePresets.map((preset) => {
    const sections = preset.sections as unknown as StorefrontSection[];
    return {
      key: preset.key,
      name: preset.name,
      description: preset.description,
      appName: app.name,
      sections,
      needsProduct: sections.some((section) => (keys.get(appKey(section) ?? "")?.length ?? 0) > 0),
    };
  }));
}

/** The preset's sections for a new page, every `product` setting of its app sections set to `productId`. */
export function landingPresetSections(preset: LandingPreset, apps: readonly ThemeApp[], productId: string | null): StorefrontSection[] {
  const keys = productKeys(apps);
  return preset.sections.map((section) => {
    const fields = keys.get(appKey(section) ?? "") ?? [];
    if (section.type !== "app" || fields.length === 0 || !productId) return section;
    const values = { ...section.settings.values };
    for (const field of fields) values[field] = productId;
    return { ...section, settings: { ...section.settings, values } };
  });
}
