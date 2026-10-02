/**
 * The editor's theme settings: colours, fonts, the brand images, the header
 * with its top bar, the menus and the footer. Each block's own settings are
 * generated from its registry schema.
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
import { FooterSketch, HeaderSketch, MobileNavigationSketch, NavigationSketch, VisualChoice } from "../ThemeChoices";
import { blockFallback, setBlockVariant, THEME_FIELD_IDS, type ThemeBlockSlot } from "../theme-settings";
import { TypographyCard } from "../TypographyCard";

type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** One group of theme settings in the sidebar: a heading, then its fields. */
export function SettingsGroup({ title, description, action, children }: {
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

/**
 * The brand: header logo (and its width), footer logo and browser tab icon,
 * picked from Files and kept as media ids in the theme draft, so they
 * preview, publish and roll back with the rest of the theme.
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
  const option = (key: string) => t(key as MessageKey);
  const fitReason = useFitReason(resolved.facts);
  const setBlock = (slot: ThemeBlockSlot) => (variant: string) => setDraft((current) => setBlockVariant(current, slot, variant));
  const blockOptions = <Render,>(slot: ThemeBlockSlot, prefix: string, sketch: (render: Render, variant: string) => ReactNode, help = false) =>
    storefrontBlockVariants(slot).map((value) => ({
      value,
      label: option(`${prefix}_${value}`),
      help: help ? option(`${prefix}_${value}Help`) : undefined,
      sketch: sketch(variantRenders<Render>(slot, value), value),
    }));
  const fitNote = (slot: ThemeBlockSlot, prefix: string) => (
    <FitNote fallback={blockFallback(resolved, slot)} name={(variant) => option(`${prefix}_${variant}`)} reason={fitReason} />
  );
  const blockFields = (slot: ThemeBlockSlot) => <BlockSettingsFields slot={slot} theme={theme} setDraft={setDraft} media={media} />;

  return (
    <div>
      <SettingsGroup title={t("colors")}>
        <ColorFields theme={theme} setDraft={setDraft} />
      </SettingsGroup>

      <TypographyCard theme={theme} setDraft={setDraft} frame={SettingsGroup} />

      <SettingsGroup title={t("logo")}>
        <BrandFields theme={theme} media={media} setDraft={setDraft} />
      </SettingsGroup>

      <SettingsGroup title={t("header")}>
        <VisualChoice
          label={t("header")}
          value={theme.blocks.header.variant}
          className="grid-cols-2"
          options={blockOptions<ResolvedStorefrontThemeLayout["header"]>("header", "header", (kind, variant) => <HeaderSketch kind={kind} variant={variant} />)}
          onChange={setBlock("header")}
        />
        {fitNote("header", "header")}
        {blockFields("header")}
        <div className="space-y-1.5">
          <Label htmlFor="theme-top-bar">{t("topBar")}</Label>
          <SearchableSelect
            id="theme-top-bar"
            value={theme.blocks.topBar.variant}
            options={storefrontBlockVariants("topBar").map((variant) => ({
              value: variant,
              label: option(`topBar_${variant}`),
              description: option(`topBar_${variant}Help`),
            }))}
            onValueChange={setBlock("topBar")}
            triggerClassName="w-full"
          />
        </div>
        {blockFields("topBar")}
      </SettingsGroup>

      <SettingsGroup
        title={t("menuStyle")}
        description={
          <>
            {t("menuStyleHelp")}{" "}
            <Link to="/admin/online-store/navigation" className="text-link hover:underline">{t("editMenus")}</Link>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="theme-navigation-source">{t("menuSource")}</Label>
          <SearchableSelect
            id="theme-navigation-source"
            value={theme.blocks.navigation.source}
            options={STOREFRONT_NAVIGATION_SOURCES.map((source) => ({
              value: source,
              label: option(`menuSource_${source}`),
              description: option(`menuSource_${source}Help`),
            }))}
            onValueChange={(source) => setDraft((current) => ({
              ...current,
              blocks: { ...current.blocks, navigation: { ...current.blocks.navigation, source: source as StorefrontNavigationSource } },
            }))}
            triggerClassName="w-full"
          />
          <FitNote
            fallback={resolved.fallbacks.find((fallback) => fallback.kind === "navigation" && fallback.key === "source") ?? null}
            name={(source) => option(`menuSource_${source}`)}
            reason={fitReason}
          />
        </div>
        <VisualChoice
          label={t("menuStyleDesktop")}
          showLabel
          value={theme.blocks.desktopNav.variant}
          className="grid-cols-2"
          options={blockOptions<ResolvedStorefrontThemeLayout["navigation"]>("desktopNav", "navigation", (kind) => <NavigationSketch kind={kind} />, true)}
          onChange={setBlock("desktopNav")}
        />
        {fitNote("desktopNav", "navigation")}
        {blockFields("desktopNav")}
        <VisualChoice
          label={t("menuStylePhone")}
          showLabel
          value={theme.blocks.mobileNav.variant}
          className="grid-cols-2"
          options={blockOptions<ResolvedStorefrontThemeLayout["mobileNavigation"]>("mobileNav", "mobileNavigation", (kind) => <MobileNavigationSketch kind={kind} />, true)}
          onChange={setBlock("mobileNav")}
        />
        {blockFields("mobileNav")}
      </SettingsGroup>

      <SettingsGroup title={t("footer")} description={t("footerLayoutHelp")}>
        <VisualChoice
          label={t("footer")}
          value={theme.blocks.footer.variant}
          className="grid-cols-2"
          options={blockOptions<ResolvedStorefrontThemeLayout["footer"]>("footer", "footer", (kind) => <FooterSketch kind={kind} />)}
          onChange={setBlock("footer")}
        />
        {fitNote("footer", "footer")}
        {blockFields("footer")}
      </SettingsGroup>
    </div>
  );
}
