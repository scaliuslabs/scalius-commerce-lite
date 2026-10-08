/**
 * The one section library (research P19): every "+" (between rows, on the
 * canvas edges, the Add section row, the phone's Add) opens it. Search,
 * categories, a thumbnail of each section drawn in the store's own colours,
 * apps' sections with an App badge, and sections that cannot be added here
 * saying why (Webflow's slot restrictions). "Draft with AI" sits at the top.
 * A click adds the section after the place the library was opened for.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Search, Sparkles, X } from "lucide-react";
import { STOREFRONT_SECTION_RENDERERS, type StorefrontSectionType, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import { Sketch, type SketchPalette } from "../ThemeChoices";

type MessageKey = keyof (typeof onlineStoreMessages)["en"];
type Category = "all" | "banners" | "products" | "text" | "apps";

const CATEGORY_OF: Record<(typeof STOREFRONT_SECTION_RENDERERS)[number], Exclude<Category, "all" | "apps">> = {
  hero: "banners",
  banner: "banners",
  "banner-mosaic": "banners",
  "shop-by": "banners",
  lookbook: "banners",
  "product-rail": "products",
  "product-grid": "products",
  "deal-block": "products",
  "product-tabs": "products",
  collections: "products",
  "endless-grid": "products",
  "recently-viewed": "products",
  "category-tiles": "products",
  "brand-wall": "products",
  editorial: "text",
  faq: "text",
  "seo-text": "text",
  "usp-strip": "text",
  "utility-cards": "text",
  newsletter: "text",
};

export type LibraryChoice = { type: StorefrontSectionType } | { app: string };

export interface LibraryOption {
  choice: LibraryChoice;
  /** Why it cannot be added here (null: it can). */
  blocked: string | null;
  /** A note that does not stop it (it shows once the store has the data). */
  note?: string;
}

function themePalette(theme: StorefrontThemeDocument): SketchPalette {
  const { colors } = theme.tokens;
  return { paper: colors.background, ink: colors.foreground, line: colors["muted-foreground"], soft: colors.muted, edge: colors.border, accent: colors.primary };
}

const Bar = ({ className }: { className?: string }) => <span className={cn("block h-1 rounded-full bg-(--sk-ink)", className)} />;
const Soft = ({ className }: { className?: string }) => <span className={cn("block rounded-xs bg-(--sk-soft)", className)} />;
const Line = ({ className }: { className?: string }) => <span className={cn("block h-0.5 rounded-full bg-(--sk-line)", className)} />;
const Accent = ({ className }: { className?: string }) => <span className={cn("block h-1.5 w-6 rounded-xs bg-(--sk-accent)", className)} />;
const Cards = ({ count, className }: { count: number; className?: string }) => (
  <span className={cn("grid min-h-0 flex-1 gap-1", className)}>
    {Array.from({ length: count }, (_, index) => <Soft key={index} className="min-h-0" />)}
  </span>
);

/** A small drawing of a section, in the store's colours. */
function SectionSketch({ type }: { type: StorefrontSectionType | "app" }): ReactNode {
  switch (type) {
    case "hero":
      return <span className="flex min-h-0 flex-1 flex-col justify-end gap-1 rounded-xs bg-(--sk-soft) p-1.5"><Bar className="w-1/2" /><Line className="w-1/3" /><Accent /></span>;
    case "banner":
      return <span className="flex min-h-0 flex-1 gap-1.5"><Soft className="flex-1" /><span className="flex flex-1 flex-col justify-center gap-1"><Bar className="w-3/4" /><Line className="w-full" /><Accent /></span></span>;
    case "banner-mosaic":
      return <span className="grid min-h-0 flex-1 grid-cols-3 grid-rows-2 gap-1"><Soft className="col-span-2 row-span-2" /><Soft /><Soft /></span>;
    case "shop-by":
    case "category-tiles":
      return <span className="flex min-h-0 flex-1 flex-col gap-1"><Bar className="w-1/3" /><Cards count={4} className="grid-cols-4" /></span>;
    case "lookbook":
      return <span className="flex min-h-0 flex-1 gap-1"><Soft className="w-2/5" /><Cards count={4} className="grid-cols-2" /></span>;
    case "product-rail":
    case "collections":
    case "recently-viewed":
      return <span className="flex min-h-0 flex-1 flex-col gap-1"><Bar className="w-1/3" /><Cards count={5} className="grid-cols-5" /></span>;
    case "product-grid":
    case "endless-grid":
      return <span className="flex min-h-0 flex-1 flex-col gap-1"><Bar className="w-1/3" /><Cards count={8} className="grid-cols-4" /></span>;
    case "deal-block":
      return <span className="flex min-h-0 flex-1 flex-col gap-1"><span className="flex items-center gap-1"><Bar className="w-1/4" /><Accent className="w-8" /></span><Cards count={4} className="grid-cols-4" /></span>;
    case "product-tabs":
      return <span className="flex min-h-0 flex-1 flex-col gap-1"><span className="flex gap-1"><Accent className="w-5" /><Line className="mt-0.5 w-5" /><Line className="mt-0.5 w-5" /></span><Cards count={4} className="grid-cols-4" /></span>;
    case "brand-wall":
      return <span className="grid min-h-0 flex-1 grid-cols-4 items-center gap-1.5">{[0, 1, 2, 3].map((index) => <Line key={index} className="h-1.5" />)}</span>;
    case "editorial":
    case "seo-text":
      return <span className="flex min-h-0 flex-1 flex-col justify-center gap-1 px-2"><Bar className="w-1/2" /><Line /><Line /><Line className="w-2/3" /></span>;
    case "faq":
      return <span className="flex min-h-0 flex-1 flex-col justify-center gap-1.5 px-1">{[0, 1, 2].map((index) => <span key={index} className="flex items-center justify-between border-b border-(--sk-edge) pb-1"><Line className="w-2/3" /><Line className="w-1.5" /></span>)}</span>;
    case "usp-strip":
      return <span className="grid min-h-0 flex-1 grid-cols-4 items-center gap-1">{[0, 1, 2, 3].map((index) => <span key={index} className="flex items-center gap-0.5"><span className="size-1.5 rounded-full bg-(--sk-accent)" /><Line className="flex-1" /></span>)}</span>;
    case "utility-cards":
      return <Cards count={4} className="grid-cols-4" />;
    case "newsletter":
      return <span className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1"><Bar className="w-1/3" /><span className="flex w-2/3 gap-1"><span className="h-2 flex-1 rounded-xs border border-(--sk-edge)" /><Accent className="h-2" /></span></span>;
    default:
      return <span className="flex min-h-0 flex-1 items-center justify-center rounded-xs border border-dashed border-(--sk-edge)"><Line className="w-1/3" /></span>;
  }
}

export function SectionLibrary({ open, onOpenChange, theme, options, apps, aiAvailable, onAdd, onDraftWithAi }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: StorefrontThemeDocument;
  options: readonly LibraryOption[];
  apps: readonly ThemeApp[];
  /** Whether "Draft with AI" leads somewhere (a provider, or the steps to connect one). */
  aiAvailable: boolean;
  onAdd: (choice: LibraryChoice) => void;
  onDraftWithAi: () => void;
}) {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  useEffect(() => {
    if (!open) {
      setQuery("");
      setCategory("all");
    }
  }, [open]);
  const appSection = useMemo(() => new Map(apps.flatMap((app) => app.sections.map((section) => [section.key, { app, section }] as const))), [apps]);
  const palette = themePalette(theme);
  const entries = options.map((option) => {
    if ("type" in option.choice) {
      const type = option.choice.type;
      return {
        option,
        key: type,
        name: store(`section_${type}` as MessageKey),
        description: t(`sectionDescription_${type}`),
        category: CATEGORY_OF[type as keyof typeof CATEGORY_OF] ?? "text",
        sketch: type as StorefrontSectionType | "app",
        app: null as null | { id: string; name: string },
      };
    }
    const entry = appSection.get(option.choice.app);
    return {
      option,
      key: option.choice.app,
      name: entry?.section.name ?? option.choice.app,
      description: entry?.section.description ?? "",
      category: "apps" as Category,
      sketch: "app" as const,
      app: entry ? { id: entry.app.id, name: entry.app.name } : null,
    };
  });
  const needle = query.trim().toLowerCase();
  const shown = entries.filter((entry) =>
    (category === "all" || entry.category === category)
    && (!needle || `${entry.name} ${entry.description} ${entry.app?.name ?? ""}`.toLowerCase().includes(needle)));
  const categories: Category[] = ["all", "banners", "products", "text", ...(entries.some((entry) => entry.category === "apps") ? ["apps" as const] : [])];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex flex-col gap-3 p-4 sm:max-w-md" data-section-library>
        <div className="flex items-start gap-2">
          <SheetHeader className="min-w-0 flex-1">
            <SheetTitle>{t("libraryTitle")}</SheetTitle>
            <SheetDescription>{t("libraryHelp")}</SheetDescription>
          </SheetHeader>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("close")}><X aria-hidden="true" /></Button>
          </SheetClose>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          {/* eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field */}
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("librarySearch")} aria-label={t("librarySearch")} className="ps-9" />
        </div>
        {aiAvailable ? (
          <button
            type="button"
            onClick={onDraftWithAi}
            className="flex min-h-11 items-center gap-2 rounded-lg bg-info-surface px-3 py-2 text-start text-body text-info hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Sparkles className="size-4 shrink-0" aria-hidden="true" />
            <span><span className="font-medium">{t("draftWithAi")}</span> {t("draftWithAiHint")}</span>
          </button>
        ) : null}
        <div role="group" aria-label={t("libraryCategories")} className="flex flex-wrap gap-1.5">
          {categories.map((value) => (
            <Button key={value} type="button" variant="outline" size="sm" aria-pressed={category === value} onClick={() => setCategory(value)}>
              {t(`libraryCategory_${value}`)}
            </Button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {shown.length === 0 ? <p className="p-4 text-center text-body text-muted-foreground">{t("libraryEmpty")}</p> : null}
          <ul className="grid grid-cols-2 gap-3">
            {shown.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  disabled={entry.option.blocked !== null}
                  aria-describedby={`library-${entry.key}-note`}
                  onClick={() => onAdd(entry.option.choice)}
                  data-library-item={entry.key}
                  className="flex w-full flex-col gap-1.5 rounded-xl bg-card p-1.5 text-start shadow-button hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Sketch palette={palette}>
                    <SectionSketch type={entry.sketch} />
                  </Sketch>
                  <span className="flex items-center gap-1.5 px-1 text-body font-medium">
                    <span className="min-w-0 truncate">{entry.name}</span>
                    {entry.app ? <Badge variant="secondary">{t("appBadge")}</Badge> : null}
                  </span>
                  <span id={`library-${entry.key}-note`} className={cn("block px-1 pb-0.5 text-body", entry.option.blocked ? "text-destructive" : "text-muted-foreground")}>
                    {entry.option.blocked ?? entry.option.note ?? entry.description}
                  </span>
                </button>
                {entry.app ? (
                  <Link to="/admin/apps/$pluginId" params={{ pluginId: entry.app.id }} className="mt-1 inline-block px-2 text-body text-link hover:underline">
                    {t("manageApp", { app: entry.app.name })}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}
