/**
 * The settings of what is selected, Shopify's settings panel: its name as
 * the title (with a way back to the tree where the panel takes the tree's
 * place), a note on why buyers may not see it, then its settings.
 */
import type { ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { ResolvedStorefrontTheme } from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import type { MediaPreviews } from "../schema-form/resource-fields";
import type { SetTheme, Theme } from "../theme-fields";
import { EDITOR_PARTS, selectedModule, type EditorPage } from "./editor-pages";
import { ListingFilterSettings, ListingGridSettings, ListingToolbarSettings } from "./ListingPanels";
import { CmsPageContent, HomePageSettings, LandingPageSettings } from "./PagePanels";
import { ProductAppBlocksSettings } from "./ProductAppBlocks";
import { ProductMainSettings, ProductModuleSettings } from "./ProductPanels";
import { AnnouncementSettings, FooterSettings, HeaderSettings } from "./ThemeSettingsPanel";

export function SettingsPanel({ title, note, onClose, closeLabel, children }: {
  title: string;
  note?: string;
  onClose: () => void;
  /** The tree's place (narrow screens) or closing the side panel (wide ones). */
  closeLabel: "back" | "close";
  children: ReactNode;
}) {
  const t = useMessages(themeEditorMessages);
  return (
    <div data-settings-panel>
      <div className="sticky top-0 z-10 flex min-h-12 items-center gap-1 border-b border-border bg-card px-2 py-1.5">
        {closeLabel === "back" ? (
          <Button type="button" variant="ghost" size="icon" aria-label={t("allSections")} onClick={onClose}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate px-2 text-heading-sm">{title}</h2>
        {closeLabel === "close" ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("closeSettings")} onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="space-y-4 px-4 py-4">
        {note ? <p role="status" className="text-body text-muted-foreground">{note}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** The title of a selected part (null for a section, whose name the editor knows). */
export function usePartTitle() {
  const t = useMessages(themeEditorMessages);
  return (selected: string, page: EditorPage): string | null => {
    const module = selectedModule(selected);
    if (module) return t(`module_${module}`);
    switch (selected) {
      case EDITOR_PARTS.announcement: return t("announcement");
      case EDITOR_PARTS.header: return t("headerRow");
      case EDITOR_PARTS.footer: return t("footerRow");
      case EDITOR_PARTS.page: return t(page.kind === "home" ? "homeSettings" : page.kind === "page" ? "pageContent" : "pageSettings");
      case EDITOR_PARTS.productMain: return t("productMain");
      case EDITOR_PARTS.productApps: return t("appBlocks");
      case EDITOR_PARTS.listingToolbar: return t("listingToolbar");
      case EDITOR_PARTS.listingFilters: return t("listingFilters");
      case EDITOR_PARTS.listing: return t("listingGrid");
      default: return null;
    }
  };
}

/** The settings of a selected part that is not a section, or null when it is a section. */
export function PartSettings({ selected, page, theme, resolved, media, apps, cmsPageId, setDraft, onRemoveLanding }: {
  selected: string;
  page: EditorPage;
  theme: Theme;
  resolved: ResolvedStorefrontTheme;
  media: MediaPreviews;
  apps: readonly ThemeApp[];
  /** The CMS page the preview shows, for its edit link. */
  cmsPageId: string | null;
  setDraft: SetTheme;
  onRemoveLanding: (slug: string) => void;
}): ReactNode {
  const shared = { theme, resolved, media, setDraft };
  const module = selectedModule(selected);
  if (module) return <ProductModuleSettings theme={theme} module={module} setDraft={setDraft} />;
  switch (selected) {
    case EDITOR_PARTS.announcement: return <AnnouncementSettings {...shared} />;
    case EDITOR_PARTS.header: return <HeaderSettings {...shared} />;
    case EDITOR_PARTS.footer: return <FooterSettings {...shared} />;
    case EDITOR_PARTS.page:
      if (page.kind === "home") return <HomePageSettings theme={theme} setDraft={setDraft} />;
      if (page.kind === "landing") return <LandingPageSettings theme={theme} slug={page.slug} setDraft={setDraft} onRemove={() => onRemoveLanding(page.slug)} />;
      return <CmsPageContent pageId={cmsPageId} />;
    case EDITOR_PARTS.productMain: return <ProductMainSettings {...shared} />;
    case EDITOR_PARTS.productApps: return <ProductAppBlocksSettings theme={theme} apps={apps} setDraft={setDraft} />;
    case EDITOR_PARTS.listingToolbar: return <ListingToolbarSettings theme={theme} setDraft={setDraft} />;
    case EDITOR_PARTS.listingFilters: return <ListingFilterSettings theme={theme} setDraft={setDraft} search={page.kind === "search"} />;
    case EDITOR_PARTS.listing: return <ListingGridSettings theme={theme} setDraft={setDraft} media={media} search={page.kind === "search"} />;
    default: return null;
  }
}
