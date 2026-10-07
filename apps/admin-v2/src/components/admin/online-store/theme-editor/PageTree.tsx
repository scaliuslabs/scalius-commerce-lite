/**
 * The left panel's tree for the page being edited, Shopify's shape: the
 * header group (announcement bar, header), the page's own template (its
 * sections, or its fixed blocks) and the footer group. Selecting a row opens
 * its settings; hovering one outlines it in the preview.
 */
import type { ReactNode } from "react";
import {
  FileText,
  LayoutGrid,
  ListFilter,
  Megaphone,
  PanelBottom,
  PanelTop,
  Puzzle,
  Settings2,
  ShoppingBag,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { Theme } from "../theme-fields";
import { toggleProductModule } from "../theme-settings";
import { EDITOR_PARTS, PRODUCT_MODULES, moduleId, type EditorPage } from "./editor-pages";
import { moveSectionTo } from "./editor-state";
import { SectionList, type TreeRow } from "./SectionList";

function TreeGroup({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-0.5 border-b border-border px-2 py-3 last:border-b-0">
      <h2 className="px-2 pb-1 text-body font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** A fixed row of the tree: selects a part that has settings but no place in a list. */
export function PartRow({ id, icon: Icon, name, note, selected, onSelect, onHover }: {
  id: string;
  icon: LucideIcon;
  name: string;
  note?: string;
  selected: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  return (
    <button
      type="button"
      data-part-row={id}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(id)}
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
      className={cn(
        "flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-1.5 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent",
      )}
    >
      <span className="flex h-lh items-center text-muted-foreground"><Icon className="size-4" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body">{name}</span>
        {note ? <span className="block text-body text-muted-foreground">{note}</span> : null}
      </span>
    </button>
  );
}

export interface SectionTree {
  rows: TreeRow[];
  onMove: (id: string, to: number) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
  /** The add-section picker and anything under it (limits, notes). */
  footer: ReactNode;
  /** Said above the sections (a homepage that opens one product). */
  note?: string;
}

export function PageTree({ theme, page, pageName, selected, onSelect, onHover, sections, resource, hasAppBlocks, readOnly = false, setDraft }: {
  theme: Theme;
  page: EditorPage;
  /** The template group's heading (the page's name). */
  pageName: string;
  selected: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  /** The homepage's or a landing page's sections. */
  sections: SectionTree | null;
  /** Which product, collection, category or page the preview shows (and changing it). */
  resource: ReactNode;
  /** Product pages: whether there are app blocks to place. */
  hasAppBlocks: boolean;
  /** Staff who may only view the theme: rows select, nothing moves, hides or is added. */
  readOnly?: boolean;
  setDraft: (update: (theme: Theme) => Theme) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const part = (id: string, icon: LucideIcon, name: string, note?: string) => (
    <PartRow key={id} id={id} icon={icon} name={name} note={note} selected={selected === id} onSelect={onSelect} onHover={onHover} />
  );
  const below = theme.blocks.product.below;
  const fixed = (rows: TreeRow[]) => (readOnly ? rows.map((row) => ({ ...row, fixed: true })) : rows);
  const moduleRows: TreeRow[] = [
    ...below.map((module) => ({ id: moduleId(module), name: t(`module_${module}`) })),
    ...PRODUCT_MODULES.filter((module) => !below.includes(module))
      .map((module) => ({ id: moduleId(module), name: t(`module_${module}`), hidden: true, fixed: true })),
  ];
  const setBelow = (update: (current: Theme["blocks"]["product"]["below"]) => Theme["blocks"]["product"]["below"]) =>
    setDraft((current) => ({ ...current, blocks: { ...current.blocks, product: { ...current.blocks.product, below: update(current.blocks.product.below) } } }));
  const moduleOf = (id: string) => PRODUCT_MODULES.find((module) => moduleId(module) === id)!;
  const listing = page.kind === "collection" || page.kind === "category" || page.kind === "search";

  return (
    <div>
      {resource}
      <TreeGroup title={t("groupHeader")}>
        {part(EDITOR_PARTS.announcement, Megaphone, t("announcement"), theme.blocks.topBar.variant === "none" ? t("off") : undefined)}
        {part(EDITOR_PARTS.header, PanelTop, t("headerRow"))}
      </TreeGroup>
      <TreeGroup title={pageName}>
        {page.kind === "home" || page.kind === "landing"
          ? part(EDITOR_PARTS.page, Settings2, t(page.kind === "home" ? "homeSettings" : "pageSettings"))
          : null}
        {sections ? (
          <>
            {sections.note ? <p role="status" className="px-3 py-1 text-body text-muted-foreground">{sections.note}</p> : null}
            {sections.rows.length === 0 ? <p className="px-3 py-1 text-body text-muted-foreground">{t("noSections")}</p> : null}
            <SectionList
              rows={fixed(sections.rows)}
              label={pageName}
              selectedId={selected}
              onSelect={onSelect}
              onHover={onHover}
              onMove={sections.onMove}
              onDuplicate={readOnly ? undefined : sections.onDuplicate}
              onRemove={readOnly ? undefined : sections.onRemove}
              onToggle={readOnly ? undefined : sections.onToggle}
            />
            {readOnly ? null : <div className="px-1 pt-1">{sections.footer}</div>}
          </>
        ) : null}
        {page.kind === "product" ? (
          <>
            {part(EDITOR_PARTS.productMain, ShoppingBag, t("productMain"))}
            <SectionList
              rows={fixed(moduleRows)}
              label={t("productModules")}
              selectedId={selected}
              onSelect={onSelect}
              onHover={onHover}
              onMove={(id, to) => setBelow((current) => moveSectionTo(current, current.indexOf(moduleOf(id)), to))}
              onToggle={readOnly ? undefined : (id) => setBelow((current) => toggleProductModule(current, moduleOf(id), !current.includes(moduleOf(id))))}
            />
            {hasAppBlocks ? part(EDITOR_PARTS.productApps, Puzzle, t("appBlocks")) : null}
          </>
        ) : null}
        {listing ? (
          <>
            {part(EDITOR_PARTS.listingToolbar, ListFilter, t("listingToolbar"))}
            {part(EDITOR_PARTS.listingFilters, SlidersHorizontal, t("listingFilters"))}
            {part(EDITOR_PARTS.listing, LayoutGrid, t("listingGrid"))}
          </>
        ) : null}
        {page.kind === "page" ? part(EDITOR_PARTS.page, FileText, t("pageContent")) : null}
      </TreeGroup>
      <TreeGroup title={t("groupFooter")}>
        {part(EDITOR_PARTS.footer, PanelBottom, t("footerRow"))}
      </TreeGroup>
    </div>
  );
}
