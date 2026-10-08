/**
 * The settings of what is selected: a section, a block, an app section or
 * a fixed part. The editor opens with nothing selected, so it loads this
 * module (and the generated forms under it) after its first render, not in
 * it; the settings are there before a merchant's first click.
 */
import { useState, type FocusEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  storefrontSectionBlockLists,
  storefrontSettingAt,
  type ResolvedStorefrontTheme,
  type StorefrontPlatformSection,
} from "@scalius/shared/storefront-theme";
import { useMessages } from "~/i18n";
import { themeSettingMessages } from "~/i18n/theme-settings";
import { sectionLabelScope, settingLabelKey } from "../schema-form/labels";
import { settingFieldId } from "../schema-form/SchemaSettingsForm";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import type { MediaPreviews } from "../schema-form/media-previews";
import { BlockSettingsForm, HeroAddSlides, SectionSettingsForm, sectionFieldPrefix, useSectionErrors } from "../SectionSettings";
import { blockId } from "./editor-selection";
import { useBlockName } from "./use-editor-tree";
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

/**
 * A section's errors as the merchant has met them: a field's error shows
 * once its field was left (or everything when the editor asks, from
 * "1 setting to fix"), never on a field nobody has touched yet.
 */
function useShownErrors(section: StorefrontPlatformSection, reveal: boolean) {
  const all = useSectionErrors(section);
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const prefix = sectionFieldPrefix(section.id);
  const errors = reveal ? all : new Map([...all].filter(([path]) => {
    const id = settingFieldId(prefix, path);
    for (const field of left) if (field === id || field.startsWith(`${id}-`)) return true;
    return false;
  }));
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const field = (event.target as HTMLElement).closest("[id]")?.id;
    if (field && !left.has(field)) setLeft((current) => new Set(current).add(field));
  };
  return { errors, onBlur };
}

/** A platform section's own settings, with its blocks listed to open (they are rows of the tree too); a hero adds slides from Files here. */
export function SectionPane({ section, media, canEdit, reveal, onSelectBlock, onChange }: {
  section: StorefrontPlatformSection;
  media: MediaPreviews;
  canEdit: boolean;
  /** Show every error at once (the merchant asked where the problem is). */
  reveal: boolean;
  onSelectBlock: (id: string) => void;
  onChange: (settings: Settings) => void;
}) {
  const { errors, onBlur } = useShownErrors(section, reveal);
  return (
    <div className="space-y-4" onBlurCapture={onBlur}>
      <SectionSettingsForm key={section.id} section={section} media={media} errors={errors} onChange={onChange} />
      <BlockLinks section={section} onSelectBlock={onSelectBlock} />
      {section.type === "hero" && canEdit ? (
        <HeroAddSlides slides={section.settings.slides} media={media} onChange={(slides) => onChange({ ...section.settings, slides })} />
      ) : null}
    </div>
  );
}

/** A section's blocks (slides, questions, cards) as links to their own settings. */
function BlockLinks({ section, onSelectBlock }: { section: StorefrontPlatformSection; onSelectBlock: (id: string) => void }) {
  const labels = useMessages(themeSettingMessages);
  const blockName = useBlockName();
  const lists = storefrontSectionBlockLists(section.type)
    .map((list) => ({ ...list, items: storefrontSettingAt(section.settings, list.path) }))
    .filter((list): list is typeof list & { items: unknown[] } => Array.isArray(list.items) && list.items.length > 0);
  if (lists.length === 0) return null;
  return (
    <>
      {lists.map((list) => {
        const key = settingLabelKey(sectionLabelScope(section.type), list.path);
        return (
          <section key={list.path} className="space-y-1" data-block-links={list.path}>
            <h3 className="text-body font-medium">{key ? labels(key) : list.path}</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {list.items.map((item, index) => (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => onSelectBlock(blockId({ sectionId: section.id, path: list.path, index }))}
                    className="flex h-10 w-full items-center gap-2 px-3 text-start text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate">{blockName(section, list.path, index, item)}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** One block of a section on its own. */
export function BlockPane({ section, path, index, media, reveal, onChange }: {
  section: StorefrontPlatformSection;
  path: string;
  index: number;
  media: MediaPreviews;
  reveal: boolean;
  onChange: (settings: Settings) => void;
}) {
  const { errors, onBlur } = useShownErrors(section, reveal);
  return (
    <div onBlurCapture={onBlur}>
      <BlockSettingsForm key={`${section.id}/${path}/${index}`} section={section} path={path} index={index} media={media} errors={errors} onChange={onChange} />
    </div>
  );
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
