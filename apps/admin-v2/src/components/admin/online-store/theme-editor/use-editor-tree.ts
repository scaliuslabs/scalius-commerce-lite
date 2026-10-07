/**
 * The page's layers as the tree shows them: what is shared on every page
 * (announcement bar and header; the footer), the page's own settings, its
 * sections and a template's fixed part in their order (each section with its
 * blocks), and the ways to add. Rows carry their notes (hidden, nothing to
 * show yet, does not fit this store, an app that is not active, a setting
 * to fix, an AI draft) and their actions.
 */
import {
  FileText,
  Image,
  LayoutGrid,
  ListFilter,
  Megaphone,
  PanelBottom,
  PanelTop,
  Puzzle,
  Settings2,
  ShoppingBag,
  ShoppingCart,
  SlidersHorizontal,
  Type,
  type LucideIcon,
} from "lucide-react";
import {
  STOREFRONT_SECTION_REGISTRY,
  failedFitConditions,
  isStorefrontAppSection,
  storefrontSectionBlockLists,
  storefrontSectionNeedsContent,
  type ResolvedStorefrontTheme,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { themeSettingMessages } from "~/i18n/theme-settings";
import { settingLabelKey, sectionLabelScope } from "../schema-form/labels";
import { appValuesInvalid } from "../schema-form/app-settings";
import { useFitReason } from "../theme-fields";
import { EDITOR_PARTS, PRODUCT_MODULES, moduleId, pageMain, pageSections, pageShowsSharedParts, pageTemplate, type EditorPage } from "./editor-pages";
import { blockId } from "./editor-selection";
import { blockList, canRemoveBlock, newBlock, pageItems, type AppSectionEntry } from "./editor-state";
import type { TreeGroupModel, TreeItemModel } from "./LayerTree";

type Theme = StorefrontThemeDocument;
type Section = StorefrontSection;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

const SECTION_ICONS: Partial<Record<StorefrontSectionType, LucideIcon>> = {
  hero: Image,
  banner: Image,
  "banner-mosaic": Image,
  "shop-by": Image,
  lookbook: Image,
  editorial: Type,
  faq: Type,
  "seo-text": Type,
  newsletter: Type,
  "usp-strip": Type,
  "utility-cards": Type,
};

export interface TreeHandlers {
  toggleSection: (id: string) => void;
  duplicateSection: (id: string) => void;
  removeSection: (id: string) => void;
  /** Opens the library to add a section at this place among the page's items. */
  addSectionAt: (index: number) => void;
  toggleBlock: (sectionId: string, path: string, index: number) => void;
  duplicateBlock: (sectionId: string, path: string, index: number) => void;
  removeBlock: (sectionId: string, path: string, index: number) => void;
  addBlock: (sectionId: string, path: string) => void;
  toggleModule: (module: (typeof PRODUCT_MODULES)[number]) => void;
}

/** The first words of a block (its heading, title, question), for its row. */
function blockSummary(item: unknown): string {
  if (typeof item !== "object" || item === null) return "";
  const record = item as Record<string, unknown>;
  for (const key of ["heading", "title", "question", "label", "quote", "alt", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 60);
  }
  return "";
}

export function useSectionName(apps: ReadonlyMap<string, AppSectionEntry>) {
  const store = useMessages(onlineStoreMessages);
  // The merchant's own heading names a section; its type otherwise.
  return (section: Section): string => {
    if (isStorefrontAppSection(section)) return apps.get(section.settings.app)?.section.name ?? section.settings.app;
    const settings = section.settings as { title?: unknown; heading?: unknown };
    const own = [settings.title, settings.heading].find((value): value is string => typeof value === "string" && value.trim() !== "");
    return own?.trim() || store(`section_${section.type}` as MessageKey);
  };
}

export function useBlockName() {
  const labels = useMessages(themeSettingMessages);
  return (section: Section, path: string, index: number, block: unknown): string => {
    const key = section.type === "app" ? null : settingLabelKey(sectionLabelScope(section.type), path, "item");
    const name = key ? labels(key, { number: index + 1 }) : labels("f.item", { number: index + 1 });
    const summary = blockSummary(block);
    return summary ? `${name}: ${summary}` : name;
  };
}

export function useEditorTree({ theme, page, pageName, resolved, appSections, heldSections, readOnly, handlers }: {
  theme: Theme;
  page: EditorPage;
  pageName: string;
  resolved: ResolvedStorefrontTheme;
  appSections: ReadonlyMap<string, AppSectionEntry>;
  /** Sections with a setting to fix (their saved value is what saves meanwhile), with the first problem. */
  heldSections: ReadonlyMap<string, string>;
  readOnly: boolean;
  handlers: TreeHandlers;
}): TreeGroupModel[] {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const labels = useMessages(themeSettingMessages);
  const fitReason = useFitReason(resolved.facts);
  const sectionName = useSectionName(appSections);
  const blockName = useBlockName();
  const editable = !readOnly;

  const sectionNote = (section: Section): Pick<TreeItemModel, "note" | "noteTone"> => {
    const held = heldSections.get(section.id);
    if (held) return { note: held, noteTone: "critical" };
    if (section.hidden) return { note: t("hidden") };
    if (isStorefrontAppSection(section)) {
      const entry = appSections.get(section.settings.app);
      if (!entry) return { note: t("appInactive") };
      if (appValuesInvalid(entry.section.settings, section.settings.values)) return { note: t("appSettingsInvalid"), noteTone: "critical" };
      return { note: t("appFrom", { app: entry.app.name }) };
    }
    const fallback = resolved.fallbacks.find((each) => each.kind === "section" && each.key === section.id);
    if (fallback) return { note: store("sectionHidden", { reason: fitReason(fallback) }) };
    const failed = failedFitConditions(STOREFRONT_SECTION_REGISTRY[section.type].requires, { facts: resolved.facts, blocks: {} });
    if (failed.length > 0) return { note: store("sectionHidden", { reason: fitReason({ failed }) }) };
    if (storefrontSectionNeedsContent(section)) return { note: store("sectionNeedsContent") };
    return {};
  };

  const blockRows = (section: Section): TreeItemModel[] => {
    if (isStorefrontAppSection(section)) return [];
    return storefrontSectionBlockLists(section.type)
      // A hero's side promotions show with the contained layout only.
      .filter((list) => !(section.type === "hero" && list.path === "sideBanners" && (section.settings as { layout?: string }).layout !== "contained-banners"))
      .filter((list) => Array.isArray(blockList(section, list.path)) && (blockList(section, list.path).length > 0 || newBlock(section, list.path) !== null))
      .flatMap((list) => {
        const blocks = blockList(section, list.path);
        const removable = canRemoveBlock(section, list.path);
        const rows: TreeItemModel[] = blocks.map((block, index) => {
          const hidden = (block as { hidden?: unknown } | null)?.hidden === true;
          return {
            id: blockId({ sectionId: section.id, path: list.path, index }),
            name: blockName(section, list.path, index, block),
            hidden,
            note: hidden ? t("hidden") : undefined,
            move: editable ? { list: `blocks:${section.id}:${list.path}`, index, count: blocks.length } : undefined,
            onToggleHidden: editable ? () => handlers.toggleBlock(section.id, list.path, index) : undefined,
            onDuplicate: editable && newBlock(section, list.path) !== null ? () => handlers.duplicateBlock(section.id, list.path, index) : undefined,
            onRemove: editable && removable ? () => handlers.removeBlock(section.id, list.path, index) : undefined,
          };
        });
        const addKey = settingLabelKey(sectionLabelScope(section.type), list.path, "add");
        if (editable && newBlock(section, list.path) !== null) {
          rows.push({
            id: `${section.id}/${list.path}/add`,
            name: addKey ? labels(addKey) : labels("f.add"),
            add: () => handlers.addBlock(section.id, list.path),
          });
        }
        return rows;
      });
  };

  const sectionRow = (section: Section, index: number, count: number): TreeItemModel => ({
    id: section.id,
    name: sectionName(section),
    icon: isStorefrontAppSection(section) ? Puzzle : SECTION_ICONS[section.type] ?? ShoppingBag,
    hidden: section.hidden === true,
    badge: section.aiDraft ? "ai" : isStorefrontAppSection(section) ? "app" : undefined,
    ...sectionNote(section),
    children: blockRows(section),
    move: editable ? { list: "page", index, count } : undefined,
    onToggleHidden: editable ? () => handlers.toggleSection(section.id) : undefined,
    onDuplicate: editable ? () => handlers.duplicateSection(section.id) : undefined,
    onRemove: editable ? () => handlers.removeSection(section.id) : undefined,
    onAddAfter: editable ? () => handlers.addSectionAt(index + 1) : undefined,
  });

  const part = (id: string, icon: LucideIcon, name: string, extra: Partial<TreeItemModel> = {}): TreeItemModel => ({ id, icon, name, ...extra });

  const fixedRow = (index: number, count: number): TreeItemModel => {
    const move = editable && count > 1 ? { list: "page", index, count } : undefined;
    switch (page.kind) {
      case "product": {
        const below = theme.blocks.product.below;
        const modules: TreeItemModel[] = [
          ...below.map((module, at) => ({
            id: moduleId(module),
            name: t(`module_${module}`),
            move: editable ? { list: "modules", index: at, count: below.length } : undefined,
            onToggleHidden: editable ? () => handlers.toggleModule(module) : undefined,
          })),
          ...PRODUCT_MODULES.filter((module) => !below.includes(module)).map((module) => ({
            id: moduleId(module),
            name: t(`module_${module}`),
            hidden: true,
            note: t("hidden"),
            onToggleHidden: editable ? () => handlers.toggleModule(module) : undefined,
          })),
        ];
        return part(EDITOR_PARTS.productMain, ShoppingBag, t("productMain"), {
          note: t("fixedPartNote"),
          move,
          children: [...modules, part(EDITOR_PARTS.productApps, Puzzle, t("appBlocks"))],
        });
      }
      case "collection":
      case "category":
      case "search":
        return part(EDITOR_PARTS.listing, LayoutGrid, t("listingMain"), {
          note: page.kind === "search" ? undefined : t("fixedPartNote"),
          move,
          children: [
            part(EDITOR_PARTS.listingToolbar, SlidersHorizontal, t("listingToolbar")),
            part(EDITOR_PARTS.listingFilters, ListFilter, t("listingFilters")),
          ],
        });
      case "cart":
        return part(EDITOR_PARTS.cart, ShoppingCart, t("cartMain"), { note: t("fixedPartNote"), move });
      default:
        return part(EDITOR_PARTS.pageContent, FileText, t("pageContent"), { note: t("fixedPartNote"), move });
    }
  };

  const sections = pageSections(theme, page);
  const main = pageMain(theme, page);
  const items = sections ? pageItems(sections, main) : [];
  const pageRows: TreeItemModel[] = [];
  if (page.kind === "home" || page.kind === "landing") {
    pageRows.push(part(EDITOR_PARTS.page, Settings2, t(page.kind === "home" ? "homeSettings" : "pageSettings")));
  }
  items.forEach((item, index) => {
    pageRows.push(item.kind === "fixed" ? fixedRow(index, items.length) : sectionRow(item.section, index, items.length));
  });
  if (page.kind === "search") pageRows.push(fixedRow(0, 1));
  if (sections && editable) {
    pageRows.push({ id: "add-section", name: t("addSection"), add: () => handlers.addSectionAt(items.length) });
  }

  const shared = pageShowsSharedParts(page);
  const homeIsProduct = page.kind === "home" && theme.pages.homeMode.kind === "product";
  return [
    {
      id: "header",
      label: t("groupShared"),
      shared: true,
      note: shared ? undefined : t("sharedHiddenOnCart"),
      items: shared ? [
        part(EDITOR_PARTS.announcement, Megaphone, t("announcement"), theme.blocks.topBar.variant === "none" ? { note: t("off") } : {}),
        part(EDITOR_PARTS.header, PanelTop, t("headerRow")),
      ] : [],
    },
    {
      id: "page",
      label: pageName,
      note: homeIsProduct ? t("homeIsProduct") : page.kind === "search" ? t("searchNoSections") : pageTemplate(page) ? t("templateNote", { page: pageName }) : undefined,
      items: pageRows,
    },
    ...(shared ? [{
      id: "footer",
      label: t("groupShared"),
      shared: true,
      items: [part(EDITOR_PARTS.footer, PanelBottom, t("footerRow"))],
    }] : []),
  ];
}

