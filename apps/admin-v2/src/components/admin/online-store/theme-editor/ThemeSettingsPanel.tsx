/**
 * Theme settings (the editor's second tab, Shopify's): colours, fonts, the
 * brand images and product cards, store-wide. The header (with its
 * announcement bar and menus) and the footer are rows of every page's tree;
 * their settings are here too, for the editor's settings panel.
 */
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  HEADER_LOGO_WIDTH_MAX,
  HEADER_LOGO_WIDTH_MIN,
  HEADER_LOGO_WIDTH_STEP,
} from "@scalius/shared/brand-presentation";
import {
  STOREFRONT_CONTAINERS,
  STOREFRONT_NAVIGATION_SOURCES,
  STOREFRONT_THEME_BUTTON_SHAPES,
  STOREFRONT_THEME_RADII,
  failedFitConditions,
  storefrontBlockVariants,
  storefrontVariantSpec,
  type ResolvedStorefrontTheme,
  type ResolvedStorefrontThemeLayout,
  type StorefrontNavigationSource,
} from "@scalius/shared/storefront-theme";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { MediaField, type MediaPreviews, type SectionMediaPreview } from "../schema-form/resource-fields";
import { BlockSettingsFields, ColorFields, FitNote, useFitReason, variantRenders, type SetTheme, type Theme } from "../theme-fields";
import { CardStyleSketch, FooterSketch, HeaderSketch, MobileNavigationSketch, NavigationSketch, VisualChoice } from "../ThemeChoices";
import { blockFallback, setBlockVariant, THEME_FIELD_IDS, type ThemeBlockSlot } from "../theme-settings";
import { TypographyCard } from "../TypographyCard";
import { ThemeRevealContext, useThemeReveal, type ThemeRevealRequest, type ThemeSettingsGroup } from "../theme-reveal";

type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** Theme settings' groups close all but one (no panel taller than the screen); null where groups stay open. */
const OpenGroup = createContext<{ open: string | null | undefined; toggle: (id: string) => void } | null>(null);

/** One group of settings in a panel: a heading (a toggle in Theme settings), what it is for, then its fields. */
function SettingsGroup({ title, description, action, defaultOpen = false, name, children }: {
  title: ReactNode;
  /** Names the group for "setting to fix": a request for it opens the group. */
  name?: ThemeSettingsGroup;
  description?: ReactNode;
  action?: ReactNode;
  /** Open until the merchant opens another group. */
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const groups = useContext(OpenGroup);
  const reveal = useThemeReveal();
  const toggle = useRef(groups?.toggle);
  toggle.current = groups?.toggle;
  const asked = name !== undefined && reveal?.group === name ? reveal.nonce : 0;
  // Opens once per request; the merchant can close it again afterwards.
  useEffect(() => {
    if (asked > 0) toggle.current?.(id);
  }, [asked, id]);
  const open = groups === null || groups.open === id || (groups.open === undefined && defaultOpen);
  return (
    <section className="border-b border-border last:border-b-0">
      {groups ? (
        <h2>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={() => groups.toggle(open ? "" : id)}
            className="flex h-12 w-full items-center justify-between gap-2 px-4 text-start text-heading-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {title}
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-180")} aria-hidden="true" />
          </button>
        </h2>
      ) : <h2 className="px-4 pt-4 text-heading-sm">{title}</h2>}
      {open ? (
        <div id={`${id}-body`} className={cn("space-y-4 px-4 pb-4", groups === null && "pt-1")}>
          {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
          {action ? <div>{action}</div> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** Page width, corners and buttons: the store's layout tokens. */
function LayoutFields({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(themeEditorMessages);
  const set = <Key extends "container" | "radius" | "buttonShape">(key: Key, value: Theme["tokens"][Key]) =>
    setDraft((current) => ({ ...current, tokens: { ...current.tokens, [key]: value } }));
  const select = <Key extends "container" | "radius" | "buttonShape">(key: Key, values: readonly Theme["tokens"][Key][]) => (
    <div className="space-y-1.5">
      <Label htmlFor={`theme-layout-${key}`}>{t(`layout_${key}`)}</Label>
      <SearchableSelect
        id={`theme-layout-${key}`}
        value={theme.tokens[key]}
        options={values.map((value) => ({ value, label: t(`layout_${key}_${value}` as Parameters<typeof t>[0]) }))}
        onValueChange={(value) => set(key, value as Theme["tokens"][Key])}
        triggerClassName="w-full"
      />
    </div>
  );
  return (
    <>
      {select("container", STOREFRONT_CONTAINERS)}
      {select("radius", STOREFRONT_THEME_RADII)}
      {select("buttonShape", STOREFRONT_THEME_BUTTON_SHAPES)}
    </>
  );
}

/** A block's variant picker as sketches, its fit note and its generated settings. */
function useBlockChoice(theme: Theme, resolved: ResolvedStorefrontTheme, setDraft: SetTheme, media: MediaPreviews) {
  const t = useMessages(onlineStoreMessages);
  const option = (key: string) => t(key as MessageKey);
  const fitReason = useFitReason(resolved.facts);
  // Header, menu and footer layouts this store cannot show yet say why (card styles depend on other blocks: their note stays below).
  const unavailable = (slot: ThemeBlockSlot, value: string): string | undefined => {
    if (slot !== "header" && slot !== "desktopNav" && slot !== "mobileNav" && slot !== "footer") return undefined;
    const failed = failedFitConditions(storefrontVariantSpec(slot, value).requires ?? [], { facts: resolved.facts, blocks: {} });
    return failed.length > 0 ? fitReason({ failed }) : undefined;
  };
  return {
    options: <Render,>(slot: ThemeBlockSlot, prefix: string, sketch: (render: Render, variant: string) => ReactNode, help = false) =>
      storefrontBlockVariants(slot).map((value) => ({
        value,
        label: option(`${prefix}_${value}`),
        help: help ? option(`${prefix}_${value}Help`) : undefined,
        unavailable: unavailable(slot, value),
        sketch: sketch(variantRenders<Render>(slot, value), value),
      })),
    set: (slot: ThemeBlockSlot) => (variant: string) => setDraft((current) => setBlockVariant(current, slot, variant)),
    fitNote: (slot: ThemeBlockSlot, prefix: string) => (
      <FitNote fallback={blockFallback(resolved, slot)} name={(variant) => option(`${prefix}_${variant}`)} reason={fitReason} />
    ),
    fields: (slot: ThemeBlockSlot) => <BlockSettingsFields slot={slot} theme={theme} setDraft={setDraft} media={media} />,
  };
}

/**
 * The brand: header logo (and its width), footer logo and browser tab icon,
 * picked from Files and kept as media ids in the theme draft, so they
 * preview, publish and restore with the rest of the theme.
 */
function BrandFields({ theme, media, setDraft }: { theme: Theme; media: MediaPreviews; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const { brand } = theme;
  const setBrand = (next: Partial<Theme["brand"]>) =>
    setDraft((current) => ({ ...current, brand: { ...current.brand, ...next } }));
  const image = (key: "logo" | "footerLogo" | "favicon") => ({
    mediaId: brand[key],
    previews: media.previews,
    fit: "contain" as const,
    onPick: (picked: SectionMediaPreview) => {
      media.remember(picked);
      setBrand({ [key]: picked.id } as Partial<Theme["brand"]>);
    },
    onRemove: () => setBrand({ [key]: null } as Partial<Theme["brand"]>),
  });
  return (
    <>
      <MediaField id={THEME_FIELD_IDS.logo} label={t("headerLogo")} help={t("headerLogoHelp")} {...image("logo")} />
      {brand.logo ? (
        <div className="space-y-1.5">
          <Label htmlFor={THEME_FIELD_IDS.logoWidth}>{t("logoWidth", { width: brand.logoWidth })}</Label>
          <input
            id={THEME_FIELD_IDS.logoWidth}
            type="range"
            min={HEADER_LOGO_WIDTH_MIN}
            max={HEADER_LOGO_WIDTH_MAX}
            step={HEADER_LOGO_WIDTH_STEP}
            value={brand.logoWidth}
            onChange={(event) => setBrand({ logoWidth: Number(event.target.value) })}
            className="h-11 w-full accent-primary sm:h-6"
            aria-valuetext={`${brand.logoWidth}px`}
          />
        </div>
      ) : null}
      <MediaField id={THEME_FIELD_IDS.footerLogo} label={t("footerLogo")} help={t("footerLogoHelp")} {...image("footerLogo")} />
      <MediaField id={THEME_FIELD_IDS.favicon} label={t("favicon")} {...image("favicon")} />
    </>
  );
}

export function ThemeSettingsPanel({ theme, resolved, media, setDraft, reveal = null }: {
  /** Opens the group a "setting to fix" is in. */
  reveal?: ThemeRevealRequest | null;
  theme: Theme;
  resolved: ResolvedStorefrontTheme;
  media: MediaPreviews;
  setDraft: SetTheme;
}) {
  const t = useMessages(onlineStoreMessages);
  const editor = useMessages(themeEditorMessages);
  const block = useBlockChoice(theme, resolved, setDraft, media);
  // One group open at a time; the panel opens as a short list of its groups.
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ThemeRevealContext.Provider value={reveal}>
    <OpenGroup.Provider value={{ open, toggle: (id) => setOpen(id || null) }}>
      <SettingsGroup title={t("colors")} name="colors">
        <ColorFields theme={theme} setDraft={setDraft} />
      </SettingsGroup>
      <TypographyCard theme={theme} setDraft={setDraft} frame={SettingsGroup} />
      <SettingsGroup title={editor("layoutGroup")}>
        <LayoutFields theme={theme} setDraft={setDraft} />
      </SettingsGroup>
      <SettingsGroup title={t("logo")} name="logo">
        <BrandFields theme={theme} media={media} setDraft={setDraft} />
      </SettingsGroup>
      {/* One card for the whole store: its facts, buy action and hover photo; its shape follows the style above. */}
      <SettingsGroup title={t("productCards")} name="productCards">
        <div className="max-w-48">
          <CardStyleSketch card={resolved.layout.productCard} />
        </div>
        {block.fields("card")}
      </SettingsGroup>
    </OpenGroup.Provider>
    </ThemeRevealContext.Provider>
  );
}

/** The announcement bar over the header. */
export function AnnouncementSettings({ theme, resolved, media, setDraft }: { theme: Theme; resolved: ResolvedStorefrontTheme; media: MediaPreviews; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const block = useBlockChoice(theme, resolved, setDraft, media);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="theme-top-bar">{t("topBar")}</Label>
        <SearchableSelect
          id="theme-top-bar"
          value={theme.blocks.topBar.variant}
          options={storefrontBlockVariants("topBar").map((variant) => ({
            value: variant,
            label: t(`topBar_${variant}` as MessageKey),
            description: t(`topBar_${variant}Help` as MessageKey),
          }))}
          onValueChange={block.set("topBar")}
          triggerClassName="w-full"
        />
      </div>
      {block.fields("topBar")}
    </div>
  );
}

/** The header's layout and the menus it shows on computers and phones. */
export function HeaderSettings({ theme, resolved, media, setDraft }: { theme: Theme; resolved: ResolvedStorefrontTheme; media: MediaPreviews; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const fitReason = useFitReason(resolved.facts);
  const editor = useMessages(themeEditorMessages);
  const block = useBlockChoice(theme, resolved, setDraft, media);
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  return (
    <OpenGroup.Provider value={{ open, toggle: (id) => setOpen(id || null) }}>
      <div className="-mx-4 -mt-4">
      <SettingsGroup title={editor("headerLayoutGroup")} defaultOpen>
        <VisualChoice
          label={t("header")}
          value={theme.blocks.header.variant}
          className="grid-cols-2"
          options={block.options<ResolvedStorefrontThemeLayout["header"]>("header", "header", (kind, variant) => <HeaderSketch kind={kind} variant={variant} />)}
          onChange={block.set("header")}
        />
        {block.fitNote("header", "header")}
        {block.fields("header")}
      </SettingsGroup>
      <SettingsGroup
        title={t("menuStyle")}
        description={<>{t("menuStyleHelp")} <Link to="/admin/online-store/navigation" className="text-link hover:underline">{t("editMenus")}</Link></>}
      >
        <div className="space-y-1.5">
          <Label htmlFor="theme-navigation-source">{t("menuSource")}</Label>
          <SearchableSelect
            id="theme-navigation-source"
            value={theme.blocks.navigation.source}
            options={STOREFRONT_NAVIGATION_SOURCES.map((source) => ({
              value: source,
              label: t(`menuSource_${source}` as MessageKey),
              description: t(`menuSource_${source}Help` as MessageKey),
            }))}
            onValueChange={(source) => setDraft((current) => ({
              ...current,
              blocks: { ...current.blocks, navigation: { ...current.blocks.navigation, source: source as StorefrontNavigationSource } },
            }))}
            triggerClassName="w-full"
          />
          <FitNote
            fallback={resolved.fallbacks.find((fallback) => fallback.kind === "navigation" && fallback.key === "source") ?? null}
            name={(source) => t(`menuSource_${source}` as MessageKey)}
            reason={fitReason}
          />
        </div>
        <VisualChoice
          label={t("menuStyleDesktop")}
          showLabel
          value={theme.blocks.desktopNav.variant}
          className="grid-cols-2"
          options={block.options<ResolvedStorefrontThemeLayout["navigation"]>("desktopNav", "navigation", (kind) => <NavigationSketch kind={kind} />, true)}
          onChange={block.set("desktopNav")}
        />
        {block.fitNote("desktopNav", "navigation")}
        {block.fields("desktopNav")}
      </SettingsGroup>
      <SettingsGroup title={t("menuStylePhone")}>
        <VisualChoice
          label={t("menuStylePhone")}
          value={theme.blocks.mobileNav.variant}
          className="grid-cols-2"
          options={block.options<ResolvedStorefrontThemeLayout["mobileNavigation"]>("mobileNav", "mobileNavigation", (kind) => <MobileNavigationSketch kind={kind} />, true)}
          onChange={block.set("mobileNav")}
        />
        {block.fields("mobileNav")}
      </SettingsGroup>
      </div>
    </OpenGroup.Provider>
  );
}

export function FooterSettings({ theme, resolved, media, setDraft }: { theme: Theme; resolved: ResolvedStorefrontTheme; media: MediaPreviews; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const block = useBlockChoice(theme, resolved, setDraft, media);
  return (
    <div className="space-y-3">
      <p className="text-body text-muted-foreground">{t("footerLayoutHelp")}</p>
      <VisualChoice
        label={t("footer")}
        value={theme.blocks.footer.variant}
        className="grid-cols-2"
        options={block.options<ResolvedStorefrontThemeLayout["footer"]>("footer", "footer", (kind) => <FooterSketch kind={kind} />)}
        onChange={block.set("footer")}
      />
      {block.fitNote("footer", "footer")}
      {block.fields("footer")}
    </div>
  );
}
