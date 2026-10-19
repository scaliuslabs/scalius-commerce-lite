// What changed between two theme documents, as short structured entries the
// dashboard translates ("Hero added to Home", "Colours changed"). Publishing
// stores the list with each version; the editor also compares a version with
// the current draft. Entries carry ids and area names only, never content.
import { z } from "zod";
import type { StorefrontThemeDocument } from "./document";
import { STOREFRONT_PAGE_TEMPLATES } from "./pages";

/** Theme-wide settings, grouped the way the editor shows them. */
export const THEME_CHANGE_AREAS = [
  "template", "colors", "typography", "style", "brand", "header", "navigation", "footer",
  "productCard", "listing", "productPage", "homeMode", "translations",
] as const;
export type ThemeChangeArea = (typeof THEME_CHANGE_AREAS)[number];

/** `home`, `landing/<slug>` or `template/<product|collection|cart|page>`. */
const pageKey = z.string().max(108);
const sectionRef = { page: pageKey, sectionId: z.string().max(40), sectionType: z.string().max(32) };

export const themeDocumentChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("section-added"), ...sectionRef }).strict(),
  z.object({ kind: z.literal("section-removed"), ...sectionRef }).strict(),
  z.object({ kind: z.literal("section-changed"), ...sectionRef }).strict(),
  z.object({ kind: z.literal("sections-reordered"), page: pageKey }).strict(),
  z.object({ kind: z.literal("page-added"), page: pageKey }).strict(),
  z.object({ kind: z.literal("page-removed"), page: pageKey }).strict(),
  z.object({ kind: z.literal("page-changed"), page: pageKey }).strict(),
  z.object({ kind: z.literal("settings-changed"), area: z.enum(THEME_CHANGE_AREAS) }).strict(),
]);
export type ThemeDocumentChange = z.infer<typeof themeDocumentChangeSchema>;

/** Most changes a version keeps; the rest are counted. */
export const THEME_VERSION_CHANGES_MAX = 20;

const TOKEN_AREA: Record<string, ThemeChangeArea> = { colors: "colors", typography: "typography", typeScale: "typography", headingCase: "typography" };
const BLOCK_AREA: Record<string, ThemeChangeArea> = {
  topBar: "header", header: "header", navigation: "navigation", desktopNav: "navigation", mobileNav: "navigation",
  card: "productCard", listing: "listing", product: "productPage", footer: "footer",
};

const SKIN_AREA: Record<string, ThemeChangeArea> = { header: "header", footer: "footer", "product-card": "productCard", "product-main": "productPage", "listing-main": "listing" };

/**
 * Equal as stored JSON: a key whose value is undefined is the same as no key
 * (an editor's working document has them; the saved one never does), so the
 * publish summary lists only what really changes.
 */
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = (record: Record<string, unknown>) => Object.keys(record).filter((key) => record[key] !== undefined);
    const own = keys(a);
    return own.length === keys(b).length && own.every((key) => equal(a[key], b[key]));
  }
  return false;
}

type SectionLike = { id: string; type: string };

function compareSections(page: string, before: readonly SectionLike[], after: readonly SectionLike[]): ThemeDocumentChange[] {
  const previous = new Map(before.map((section) => [section.id, section]));
  const current = new Map(after.map((section) => [section.id, section]));
  const changes: ThemeDocumentChange[] = [];
  const ref = (section: SectionLike) => ({ page, sectionId: section.id, sectionType: section.type });
  for (const section of before) if (!current.has(section.id)) changes.push({ kind: "section-removed", ...ref(section) });
  for (const section of after) {
    const old = previous.get(section.id);
    if (!old) changes.push({ kind: "section-added", ...ref(section) });
    else if (!equal(old, section)) changes.push({ kind: "section-changed", ...ref(section) });
  }
  const kept = (list: readonly SectionLike[], other: Map<string, SectionLike>) => list.filter((section) => other.has(section.id)).map((section) => section.id);
  if (!equal(kept(before, current), kept(after, previous))) changes.push({ kind: "sections-reordered", page });
  return changes;
}

function areas(before: Record<string, unknown>, after: Record<string, unknown>, map: Record<string, ThemeChangeArea>, fallback: ThemeChangeArea): ThemeChangeArea[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  // Each key is judged alone: a colour change never names fonts.
  return [...keys].filter((key) => !equal(before[key], after[key])).map((key) => map[key] ?? fallback);
}

/** The changes from `before` to `after`, in a stable order: pages first, then theme settings. */
export function compareThemeDocuments(before: StorefrontThemeDocument, after: StorefrontThemeDocument): ThemeDocumentChange[] {
  const changes = compareSections("home", before.pages.home, after.pages.home);
  const slugs = new Set([...Object.keys(before.pages.landing), ...Object.keys(after.pages.landing)]);
  for (const slug of slugs) {
    const page = `landing/${slug}`;
    const old = before.pages.landing[slug];
    const next = after.pages.landing[slug];
    if (!old) changes.push({ kind: "page-added", page });
    else if (!next) changes.push({ kind: "page-removed", page });
    else {
      if (old.title !== next.title || old.description !== next.description) changes.push({ kind: "page-changed", page });
      changes.push(...compareSections(page, old.sections, next.sections));
    }
  }
  for (const kind of STOREFRONT_PAGE_TEMPLATES) {
    const page = `template/${kind}`;
    const old = before.pages.templates[kind];
    const next = after.pages.templates[kind];
    const sections = compareSections(page, old.sections, next.sections);
    // The fixed part moving among the sections is a reorder too.
    if (old.main !== next.main && !sections.some((change) => change.kind === "sections-reordered")) {
      sections.push({ kind: "sections-reordered", page });
    }
    changes.push(...sections);
  }
  const changed = new Set<ThemeChangeArea>([
    ...(before.template === after.template ? [] : ["template" as const]),
    ...areas(before.tokens, after.tokens, TOKEN_AREA, "style"),
    ...(equal(before.brand, after.brand) ? [] : ["brand" as const]),
    ...areas(before.blocks, after.blocks, BLOCK_AREA, "style"),
    ...areas(before.apps?.skins ?? {}, after.apps?.skins ?? {}, SKIN_AREA, "template"),
    ...(before.apps?.template === after.apps?.template ? [] : ["template" as const]),
    ...(equal(before.pages.homeMode, after.pages.homeMode) ? [] : ["homeMode" as const]),
    ...(equal(before.translations ?? [], after.translations ?? []) ? [] : ["translations" as const]),
  ]);
  for (const area of THEME_CHANGE_AREAS) if (changed.has(area)) changes.push({ kind: "settings-changed", area });
  return changes;
}
