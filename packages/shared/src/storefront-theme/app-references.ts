// Where a theme document names an app (apps.ts, skins.ts), and which of
// those places would fall back to the store's own design with a given set of
// active apps. The storefront draws an app's part only while the app is
// active and still declares it (apps/storefront/src/lib/extensions: `appSkin`,
// `appSlotComponents`, AppSection); otherwise core draws the unit or the
// section draws nothing. Publishing refuses a theme with such parts, and the
// dashboard warns which published parts fall back before an app is turned off.

import { parsePluginSurfaceKey } from "../plugins/storefront";
import { storefrontComponentProductSlot, type StorefrontSkinTarget } from "../plugins/storefront-protocol";
import type { StorefrontExtension } from "../plugins/storefront-components";
import type { StorefrontThemeDocument } from "./document";
import type { StorefrontPageTemplate } from "./pages";
import type { StorefrontSection } from "./sections";
import type { StorefrontThemeSkinUnit } from "./apps";

/**
 * What kind of app part: a component section (`type: "app"`), a core
 * section's own skin (`section.skin`), a unit skin (`apps.skins.<unit>`) or a
 * product-page app block (`blocks.product.apps[]`).
 */
export type StorefrontThemeAppPartKind = "section" | "section_skin" | "skin" | "product_block";

/** Where the part sits: a page's sections (by position), the product page, or the whole theme (a unit skin). */
export interface StorefrontThemeAppPlace {
  page: "home" | "landing" | "template" | "theme";
  /** A landing page's handle. */
  slug?: string;
  /** A page template (`product` for a product app block). */
  template?: StorefrontPageTemplate;
  /** The section's (or product block's) position, from 0. */
  index?: number;
}

export interface StorefrontThemeAppReference {
  pluginId: string;
  /** The app's section type, skin id or component type. */
  type: string;
  kind: StorefrontThemeAppPartKind;
  /** A skin's target: the unit, or `section:<core section type>`. */
  target?: StorefrontSkinTarget;
  /** The document path of the reference (`pages.home.2.settings.app`). */
  path: string;
  place: StorefrontThemeAppPlace;
  /** A hidden section: it draws nothing, so it never falls back. */
  hidden?: true;
}

export type StorefrontThemeAppIssueReason = "app_inactive" | "not_declared";

export interface StorefrontThemeAppIssue extends StorefrontThemeAppReference {
  reason: StorefrontThemeAppIssueReason;
}

const SKIN_UNITS: readonly StorefrontThemeSkinUnit[] = ["header", "footer", "product_card", "product_main", "listing_main"];

function sectionReferences(sections: readonly StorefrontSection[], base: string, place: Omit<StorefrontThemeAppPlace, "index">): StorefrontThemeAppReference[] {
  return sections.flatMap((section, index): StorefrontThemeAppReference[] => {
    const hidden = section.hidden === true ? { hidden: true as const } : {};
    if (section.type === "app") {
      const key = parsePluginSurfaceKey(section.settings.app);
      return key ? [{ ...key, kind: "section", path: `${base}.${index}.settings.app`, place: { ...place, index }, ...hidden }] : [];
    }
    const skin = section.skin ? parsePluginSurfaceKey(section.skin.app) : null;
    return skin ? [{
      ...skin,
      kind: "section_skin",
      target: `section:${section.type}`,
      path: `${base}.${index}.skin.app`,
      place: { ...place, index },
      ...hidden,
    }] : [];
  });
}

/** Every place the document names an app, in document order: unit skins, product blocks, then the pages. */
export function storefrontThemeAppReferences(theme: StorefrontThemeDocument): StorefrontThemeAppReference[] {
  const skins = theme.apps?.skins ?? {};
  const units = SKIN_UNITS.flatMap((unit): StorefrontThemeAppReference[] => {
    const ref = skins[unit];
    const key = ref ? parsePluginSurfaceKey(ref.app) : null;
    return key ? [{ ...key, kind: "skin", target: unit, path: `apps.skins.${unit}.app`, place: { page: "theme" } }] : [];
  });
  const blocks = (theme.blocks.product.apps ?? []).flatMap((block, index): StorefrontThemeAppReference[] => {
    const key = parsePluginSurfaceKey(block.app);
    return key ? [{ ...key, kind: "product_block", path: `blocks.product.apps.${index}.app`, place: { page: "template", template: "product", index } }] : [];
  });
  return [
    ...units,
    ...blocks,
    ...sectionReferences(theme.pages.home, "pages.home", { page: "home" }),
    ...Object.entries(theme.pages.landing).flatMap(([slug, page]) =>
      sectionReferences(page.sections, `pages.landing.${slug}.sections`, { page: "landing", slug })),
    ...(Object.entries(theme.pages.templates) as Array<[StorefrontPageTemplate, { sections: StorefrontSection[] }]>).flatMap(([template, value]) =>
      sectionReferences(value.sections, `pages.templates.${template}.sections`, { page: "template", template })),
  ];
}

/** Whether the active app still declares the part, by the storefront's own rules. */
function declares(extension: StorefrontExtension, reference: StorefrontThemeAppReference): boolean {
  switch (reference.kind) {
    case "section":
      return extension.sections.includes(reference.type) && Object.hasOwn(extension.sectionSettings, reference.type);
    case "section_skin":
    case "skin":
      return extension.skins.some((skin) => skin.id === reference.type && skin.target === reference.target);
    case "product_block": {
      const component = extension.components.find((entry) => entry.type === reference.type);
      return component !== undefined && storefrontComponentProductSlot(component.targets) !== null;
    }
  }
}

/**
 * The parts that would fall back with these active apps (the layout's
 * `appExtensions`): the app is not active (or its storefront code is not
 * approved), or it no longer declares that section, that skin for that
 * target, or that component for a product slot. Hidden sections draw
 * nothing, so they never fall back.
 */
export function storefrontThemeAppIssues(theme: StorefrontThemeDocument, extensions: readonly StorefrontExtension[]): StorefrontThemeAppIssue[] {
  const byId = new Map(extensions.map((extension) => [extension.pluginId, extension]));
  return storefrontThemeAppReferences(theme).flatMap((reference): StorefrontThemeAppIssue[] => {
    if (reference.hidden) return [];
    const extension = byId.get(reference.pluginId);
    if (!extension) return [{ ...reference, reason: "app_inactive" }];
    return declares(extension, reference) ? [] : [{ ...reference, reason: "not_declared" }];
  });
}

// ── Named parts (publish refusals, deactivation warnings) ──────────────────

/** An installed app as its manifest names it and its storefront parts. */
export interface StorefrontThemeAppManifest {
  pluginId: string;
  manifest: {
    name: string;
    storefront: {
      sections: ReadonlyArray<{ type: string; name: string }>;
      skins: ReadonlyArray<{ id: string; name: string }>;
      components: ReadonlyArray<{ type: string; name: string }>;
    };
  };
}

/** A part as the dashboard shows it: where it is and the app's own name for it. */
export interface StorefrontThemeAppPart {
  kind: StorefrontThemeAppPartKind;
  type: string;
  target?: StorefrontSkinTarget;
  path: string;
  place: StorefrontThemeAppPlace;
  /** The app's name for the section, skin or block; absent when it no longer declares one. */
  name?: string;
}

export interface StorefrontThemeAppProblem {
  pluginId: string;
  /** The app's name; absent when it is not installed. */
  name?: string;
  reason: StorefrontThemeAppIssueReason;
  /** Its parts, bounded (see `moreParts`). */
  parts: StorefrontThemeAppPart[];
}

/** Most parts one answer lists (across apps); the rest are counted. */
export const STOREFRONT_THEME_APP_PARTS_MAX = 20;

function partName(app: StorefrontThemeAppManifest | undefined, reference: StorefrontThemeAppReference): string | undefined {
  const storefront = app?.manifest.storefront;
  if (!storefront) return undefined;
  if (reference.kind === "section") return storefront.sections.find((entry) => entry.type === reference.type)?.name;
  if (reference.kind === "product_block") return storefront.components.find((entry) => entry.type === reference.type)?.name;
  return storefront.skins.find((entry) => entry.id === reference.type)?.name;
}

/** A reference as a named part. */
export function storefrontThemeAppPart(reference: StorefrontThemeAppReference, app?: StorefrontThemeAppManifest): StorefrontThemeAppPart {
  const name = partName(app, reference);
  return {
    kind: reference.kind,
    type: reference.type,
    ...(reference.target ? { target: reference.target } : {}),
    path: reference.path,
    place: reference.place,
    ...(name ? { name } : {}),
  };
}

/**
 * Parts named by their apps, bounded to `limit` in all: `parts` in document
 * order, `more` the parts left out.
 */
export function storefrontThemeAppParts(
  references: readonly StorefrontThemeAppReference[],
  apps: Iterable<StorefrontThemeAppManifest>,
  limit = STOREFRONT_THEME_APP_PARTS_MAX,
): { parts: StorefrontThemeAppPart[]; more: number } {
  const byId = new Map([...apps].map((app) => [app.pluginId, app]));
  return {
    parts: references.slice(0, limit).map((reference) => storefrontThemeAppPart(reference, byId.get(reference.pluginId))),
    more: Math.max(0, references.length - limit),
  };
}

/**
 * Issues grouped by app, in the order the document first names each, with
 * the app's name (installed apps), at most `limit` apps and `limit` parts in
 * all (`moreParts`: the issues left out). One app's
 * issues share their reason: an app that is not active falls back
 * everywhere; an active one only where it no longer declares the part.
 */
export function storefrontThemeAppProblems(
  issues: readonly StorefrontThemeAppIssue[],
  apps: Iterable<StorefrontThemeAppManifest>,
  limit = STOREFRONT_THEME_APP_PARTS_MAX,
): { apps: StorefrontThemeAppProblem[]; moreParts: number } {
  const byId = new Map([...apps].map((app) => [app.pluginId, app]));
  const groups = new Map<string, StorefrontThemeAppProblem>();
  let listed = 0;
  for (const issue of issues) {
    let group = groups.get(issue.pluginId);
    if (!group) {
      if (groups.size >= limit) continue;
      const name = byId.get(issue.pluginId)?.manifest.name;
      group = { pluginId: issue.pluginId, ...(name ? { name } : {}), reason: issue.reason, parts: [] };
      groups.set(issue.pluginId, group);
    }
    if (listed < limit) {
      group.parts.push(storefrontThemeAppPart(issue, byId.get(issue.pluginId)));
      listed += 1;
    }
  }
  return { apps: [...groups.values()], moreParts: issues.length - listed };
}
