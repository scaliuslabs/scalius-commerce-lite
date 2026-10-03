/**
 * Theme settings (the editor's second tab, Shopify's): colours, fonts, the
 * brand images and product cards, store-wide. The header (with its
 * announcement bar and menus) and the footer are rows of every page's tree;
 * their settings are here too, for the editor's settings panel.
 */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  HEADER_LOGO_WIDTH_MAX,
  HEADER_LOGO_WIDTH_MIN,
  HEADER_LOGO_WIDTH_STEP,
} from "@scalius/shared/brand-presentation";
import {
  STOREFRONT_NAVIGATION_SOURCES,
  storefrontBlockVariants,
  type ResolvedStorefrontTheme,
  type ResolvedStorefrontThemeLayout,
  type StorefrontNavigationSource,
} from "@scalius/shared/storefront-theme";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { MediaField, type MediaPreviews, type SectionMediaPreview } from "../schema-form/resource-fields";
import { BlockSettingsFields, ColorFields, FitNote, useFitReason, variantRenders, type SetTheme, type Theme } from "../theme-fields";
import { CardStyleSketch, FooterSketch, HeaderSketch, MobileNavigationSketch, NavigationSketch, VisualChoice } from "../ThemeChoices";
import { blockFallback, blockVariant, setBlockVariant, THEME_FIELD_IDS, type ThemeBlockSlot } from "../theme-settings";
import { TypographyCard } from "../TypographyCard";

type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** One group of settings in a panel: a heading, then its fields. */
function SettingsGroup({ title, description, action, children }: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="space-y-4 border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-heading-sm">{title}</h2>
          {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A block's variant picker as sketches, its fit note and its generated settings. */
function useBlockChoice(theme: Theme, resolved: ResolvedStorefrontTheme, setDraft: SetTheme, media: MediaPreviews) {
  const t = useMessages(onlineStoreMessages);
  const option = (key: string) => t(key as MessageKey);
  const fitReason = useFitReason(resolved.facts);
  return {
    options: <Render,>(slot: ThemeBlockSlot, prefix: string, sketch: (render: Render, variant: string) => ReactNode, help = false) =>
      storefrontBlockVariants(slot).map((value) => ({
        value,
        label: option(`${prefix}_${value}`),
        help: help ? option(`${prefix}_${value}Help`) : undefined,
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

export function ThemeSettingsPanel({ theme, resolved, media, setDraft }: {
  theme: Theme;
  resolved: ResolvedStorefrontTheme;
  media: MediaPreviews;
  setDraft: SetTheme;
}) {
  const t = useMessages(onlineStoreMessages);
  const block = useBlockChoice(theme, resolved, setDraft, media);
  return (
    <div>
      <SettingsGroup title={t("colors")}>
        <ColorFields theme={theme} setDraft={setDraft} />
      </SettingsGroup>
      <TypographyCard theme={theme} setDraft={setDraft} frame={SettingsGroup} />
      <SettingsGroup title={t("logo")}>
        <BrandFields theme={theme} media={media} setDraft={setDraft} />
      </SettingsGroup>
      <SettingsGroup title={t("productCards")}>
        <VisualChoice
          label={t("productCards")}
          value={blockVariant(theme, "card")}
          className="grid-cols-2"
          options={block.options<Omit<ResolvedStorefrontThemeLayout["productCard"], "imageRatio">>("card", "cardStyle", (card, variant) => (
            <CardStyleSketch variant={variant} card={{ ...(variant === "quick-add" && theme.blocks.card.variant === variant ? resolved.layout.productCard : card), imageRatio: resolved.layout.productCard.imageRatio }} />
          ), true)}
          onChange={block.set("card")}
        />
        {block.fields("card")}
      </SettingsGroup>
    </div>
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
  const block = useBlockChoice(theme, resolved, setDraft, media);
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <VisualChoice
          label={t("header")}
          value={theme.blocks.header.variant}
          className="grid-cols-2"
          options={block.options<ResolvedStorefrontThemeLayout["header"]>("header", "header", (kind, variant) => <HeaderSketch kind={kind} variant={variant} />)}
          onChange={block.set("header")}
        />
        {block.fitNote("header", "header")}
        {block.fields("header")}
      </div>
      <div className="space-y-3 border-t border-border pt-4">
        <div className="space-y-1">
          <p className="text-body font-medium">{t("menuStyle")}</p>
          <p className="text-body text-muted-foreground">
            {t("menuStyleHelp")}{" "}
            <Link to="/admin/online-store/navigation" className="text-link hover:underline">{t("editMenus")}</Link>
          </p>
        </div>
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
        <VisualChoice
          label={t("menuStylePhone")}
          showLabel
          value={theme.blocks.mobileNav.variant}
          className="grid-cols-2"
          options={block.options<ResolvedStorefrontThemeLayout["mobileNavigation"]>("mobileNav", "mobileNavigation", (kind) => <MobileNavigationSketch kind={kind} />, true)}
          onChange={block.set("mobileNav")}
        />
        {block.fields("mobileNav")}
      </div>
    </div>
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
