/**
 * What autosave sends when part of the working document is not valid yet
 * (research P16: an invalid field blocks only itself). The document splits
 * into parts that are checked one by one: the tokens, the brand, each block,
 * each unit an app skin draws, each section, a landing page's own fields and the
 * home mode. A part that
 * fails keeps its last saved value in what is sent (a new section that is
 * not valid yet is left out), while the field keeps the merchant's input and
 * shows its error. Everything else keeps saving.
 */
import {
  storefrontThemeDocumentSchema,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import {
  announcementLinkInvalid,
  homeProductMissing,
  invalidAppSkins,
  sectionSkinInvalid,
  productAppBlocksInvalid,
  themeContrastProblems,
  allThemeColorsValid,
  type AppBlockEntry,
  type AppSkinEntry,
  type AppSkinUnit,
} from "../theme-settings";
import { appSectionInvalid, type AppSectionEntry } from "./editor-state";

type Theme = StorefrontThemeDocument;
type Path = ReadonlyArray<string | number>;

/** One independently saved part, by key: `tokens`, `brand`, `block:<slot>`, `skin:<unit>`, `apps`, `section:<list>:<id>`, `list:<list>`, `landing:<slug>`, `homeMode`. */
export type DraftPart = string;

/** What the store's active apps offer, by key: their values are checked against what each declares. */
export interface DraftApps {
  sections: ReadonlyMap<string, AppSectionEntry>;
  blocks: ReadonlyMap<string, AppBlockEntry>;
  skins: ReadonlyMap<string, AppSkinEntry>;
}

/** Section lists by key: `home`, `landing:<slug>`, `template:<kind>`. */
function sectionList(theme: Theme, list: string): StorefrontSection[] | null {
  if (list === "home") return theme.pages.home;
  if (list.startsWith("landing:")) return theme.pages.landing[list.slice(8)]?.sections ?? null;
  if (list.startsWith("template:")) return theme.pages.templates[list.slice(9) as keyof Theme["pages"]["templates"]]?.sections ?? null;
  return null;
}

function withSectionList(theme: Theme, list: string, sections: StorefrontSection[]): Theme {
  if (list === "home") return { ...theme, pages: { ...theme.pages, home: sections } };
  if (list.startsWith("landing:")) {
    const slug = list.slice(8);
    const page = theme.pages.landing[slug];
    return page ? { ...theme, pages: { ...theme.pages, landing: { ...theme.pages.landing, [slug]: { ...page, sections } } } } : theme;
  }
  const kind = list.slice(9) as keyof Theme["pages"]["templates"];
  const template = theme.pages.templates[kind];
  const main = Math.min(template.main, sections.length);
  return { ...theme, pages: { ...theme.pages, templates: { ...theme.pages.templates, [kind]: { sections, main } } } };
}

/** The part a schema issue's path falls in. */
export function draftPartOf(theme: Theme, path: Path): DraftPart {
  const [area, second, third, fourth, fifth] = path;
  if (area === "tokens") return "tokens";
  if (area === "brand") return "brand";
  if (area === "apps") return second === "skins" && typeof third === "string" ? `skin:${third}` : "apps";
  if (area === "blocks") {
    if (second === "product" && (third === "gallery" || third === "buyBox" || third === "apps")) return `block:product.${third}`;
    return `block:${String(second)}`;
  }
  if (area === "pages") {
    if (second === "homeMode") return "homeMode";
    if (second === "home") {
      const section = typeof third === "number" ? theme.pages.home[third] : undefined;
      return section ? `section:home:${section.id}` : "list:home";
    }
    if (second === "landing" && typeof third === "string") {
      if (fourth === "sections") {
        const section = typeof fifth === "number" ? theme.pages.landing[third]?.sections[fifth] : undefined;
        return section ? `section:landing:${third}:${section.id}` : `list:landing:${third}`;
      }
      return `landing:${third}`;
    }
    if (second === "templates" && typeof third === "string") {
      const kind = third as keyof Theme["pages"]["templates"];
      const section = fourth === "sections" && typeof fifth === "number" ? theme.pages.templates[kind]?.sections[fifth] : undefined;
      return section ? `section:template:${third}:${section.id}` : `list:template:${third}`;
    }
  }
  return "document";
}

/** The working document with one part as it was saved. */
function withSavedPart(working: Theme, saved: Theme, part: DraftPart): Theme | null {
  if (part === "tokens") return { ...working, tokens: saved.tokens };
  if (part === "brand") return { ...working, brand: saved.brand };
  if (part === "homeMode") return { ...working, pages: { ...working.pages, homeMode: saved.pages.homeMode } };
  if (part === "apps") {
    const { apps: _apps, ...document } = working;
    return saved.apps && Object.keys(saved.apps).length > 0 ? { ...document, apps: saved.apps } : document;
  }
  if (part.startsWith("skin:")) {
    // One unit's skin as saved; the rest as edited.
    const unit = part.slice(5) as AppSkinUnit;
    const { apps: _apps, ...document } = working;
    const { [unit]: _edited, ...others } = working.apps?.skins ?? {};
    const before = saved.apps?.skins?.[unit];
    const skins = before === undefined ? others : { ...others, [unit]: before };
    const { skins: _skins, ...rest } = working.apps ?? {};
    const apps = Object.keys(skins).length > 0 ? { ...rest, skins } : rest;
    return Object.keys(apps).length > 0 ? { ...document, apps } : document;
  }
  if (part.startsWith("block:product.")) {
    const key = part.slice("block:product.".length) as "gallery" | "buyBox" | "apps";
    const product = { ...working.blocks.product } as Record<string, unknown>;
    const before = (saved.blocks.product as Record<string, unknown>)[key];
    if (before === undefined) delete product[key];
    else product[key] = before;
    return { ...working, blocks: { ...working.blocks, product: product as Theme["blocks"]["product"] } };
  }
  if (part.startsWith("block:")) {
    const slot = part.slice(6) as keyof Theme["blocks"];
    return { ...working, blocks: { ...working.blocks, [slot]: saved.blocks[slot] } };
  }
  if (part.startsWith("landing:")) {
    const slug = part.slice(8);
    const page = working.pages.landing[slug];
    const before = saved.pages.landing[slug];
    if (!page) return working;
    const landing = { ...working.pages.landing };
    // A new landing page that is not valid yet waits; an existing one keeps its saved words.
    if (before) landing[slug] = { ...before, sections: page.sections };
    else delete landing[slug];
    return { ...working, pages: { ...working.pages, landing } };
  }
  if (part.startsWith("list:")) {
    const list = part.slice(5);
    const before = sectionList(saved, list);
    return before ? withSectionList(working, list, before) : null;
  }
  if (part.startsWith("section:")) {
    const rest = part.slice(8);
    const at = rest.lastIndexOf(":");
    const list = rest.slice(0, at);
    const id = rest.slice(at + 1);
    const sections = sectionList(working, list);
    if (!sections) return null;
    const before = sectionList(saved, list)?.find((section) => section.id === id);
    const next = before
      ? sections.map((section) => (section.id === id ? before : section))
      : sections.filter((section) => section.id !== id);
    return withSectionList(working, list, next);
  }
  return null;
}

/** The parts the platform's own checks reject (beyond the schema): readable colours, a usable announcement link, apps' values. */
function checkedParts(theme: Theme, apps: DraftApps): DraftPart[] {
  const parts: DraftPart[] = [];
  if (!allThemeColorsValid(theme.tokens.colors) || themeContrastProblems(theme).length > 0) parts.push("tokens");
  if (announcementLinkInvalid(theme)) parts.push("block:topBar");
  if (homeProductMissing(theme)) parts.push("homeMode");
  if (productAppBlocksInvalid(theme, apps.blocks)) parts.push("block:product.apps");
  for (const unit of invalidAppSkins(theme, apps.skins)) parts.push(`skin:${unit}`);
  const lists: Array<[string, StorefrontSection[]]> = [
    ["home", theme.pages.home],
    ...Object.entries(theme.pages.landing).map(([slug, page]) => [`landing:${slug}`, page.sections] as [string, StorefrontSection[]]),
    ...Object.entries(theme.pages.templates).map(([kind, template]) => [`template:${kind}`, template.sections] as [string, StorefrontSection[]]),
  ];
  for (const [list, sections] of lists) {
    for (const section of sections) {
      if (appSectionInvalid(section, apps.sections) || sectionSkinInvalid(section, apps.skins)) parts.push(`section:${list}:${section.id}`);
    }
  }
  return parts;
}

/** Every part of the document that is not valid now. */
export function invalidDraftParts(theme: Theme, apps: DraftApps): DraftPart[] {
  const parts = new Set(checkedParts(theme, apps));
  const result = storefrontThemeDocumentSchema.safeParse(theme);
  if (!result.success) for (const issue of result.error.issues) parts.add(draftPartOf(theme, issue.path as Path));
  return [...parts];
}

/**
 * What autosave may send now: the working document with every invalid part
 * as it was saved, and the parts held back. Null when no valid document can
 * be made (a problem across parts, such as a variant whose colours a
 * merchant's palette cannot read): the status then says what to fix.
 */
export function saveableDraft(working: Theme, saved: Theme, apps: DraftApps): { theme: Theme; held: DraftPart[] } | null {
  const held = new Set<DraftPart>();
  let candidate = working;
  // A part held back can make another one invalid (a section list without a new section); three rounds settle it.
  for (let round = 0; round < 3; round += 1) {
    const invalid = invalidDraftParts(candidate, apps);
    if (invalid.length === 0) return { theme: candidate, held: [...held] };
    for (const part of invalid) {
      if (part === "document") return null;
      const next = withSavedPart(candidate, saved, part);
      if (!next) return null;
      candidate = next;
      held.add(part);
    }
  }
  return invalidDraftParts(candidate, apps).length === 0 ? { theme: candidate, held: [...held] } : null;
}
