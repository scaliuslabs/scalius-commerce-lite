/**
 * The settings of what is selected: a section, a block, an app section or
 * a fixed part. The editor opens with nothing selected, so it loads this
 * module (and the generated forms under it) after its first render, not in
 * it; the settings are there before a merchant's first click.
 */
import type { ReactNode } from "react";
import type { ResolvedStorefrontTheme, StorefrontPlatformSection } from "@scalius/shared/storefront-theme";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import type { MediaPreviews } from "../schema-form/media-previews";
import { BlockSettingsForm, HeroAddSlides, SectionSettingsForm, useSectionErrors } from "../SectionSettings";
import type { SetTheme, Theme } from "../theme-fields";
import { EDITOR_PARTS, selectedModule, type EditorPage } from "./editor-pages";
import { ListingFilterSettings, ListingGridSettings, ListingToolbarSettings } from "./ListingPanels";
import { CartContent, CmsPageContent, HomePageSettings, LandingPageSettings } from "./PagePanels";
import { ProductAppBlocksSettings } from "./ProductAppBlocks";
import { ProductMainSettings, ProductModuleSettings } from "./ProductPanels";
import { AnnouncementSettings, FooterSettings, HeaderSettings } from "./ThemeSettingsPanel";

export { AppSectionSettings } from "./AppSectionSettings";
export { ThemeSettingsPanel } from "./ThemeSettingsPanel";

type Settings = StorefrontPlatformSection["settings"];

/** A platform section's own settings (its blocks are rows of the tree); a hero adds slides from Files here. */
export function SectionPane({ section, media, canEdit, onChange }: {
  section: StorefrontPlatformSection;
  media: MediaPreviews;
  canEdit: boolean;
  onChange: (settings: Settings) => void;
}) {
  const errors = useSectionErrors(section);
  return (
    <>
      <SectionSettingsForm key={section.id} section={section} media={media} errors={errors} onChange={onChange} />
      {section.type === "hero" && canEdit ? (
        <HeroAddSlides slides={section.settings.slides} media={media} onChange={(slides) => onChange({ ...section.settings, slides })} />
      ) : null}
    </>
  );
}

/** One block of a section on its own. */
export function BlockPane({ section, path, index, media, onChange }: {
  section: StorefrontPlatformSection;
  path: string;
  index: number;
  media: MediaPreviews;
  onChange: (settings: Settings) => void;
}) {
  const errors = useSectionErrors(section);
  return <BlockSettingsForm key={`${section.id}/${path}/${index}`} section={section} path={path} index={index} media={media} errors={errors} onChange={onChange} />;
}

/** The settings of a selected part that is not a section (partHasSettings says which have some). */
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
      return null;
    case EDITOR_PARTS.pageContent: return <CmsPageContent pageId={cmsPageId} />;
    case EDITOR_PARTS.cart: return <CartContent />;
    case EDITOR_PARTS.productMain: return <ProductMainSettings {...shared} />;
    case EDITOR_PARTS.productApps: return <ProductAppBlocksSettings theme={theme} apps={apps} setDraft={setDraft} />;
    case EDITOR_PARTS.listing: return <ListingGridSettings theme={theme} setDraft={setDraft} media={media} search={page.kind === "search"} />;
    case EDITOR_PARTS.listingToolbar: return <ListingToolbarSettings theme={theme} setDraft={setDraft} />;
    case EDITOR_PARTS.listingFilters: return <ListingFilterSettings theme={theme} setDraft={setDraft} search={page.kind === "search"} />;
    default: return null;
  }
}
