import { useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  postApiV1AdminSettingsFooter,
  postApiV1AdminSettingsHeader,
  postApiV1AdminSettingsTheme,
} from "@scalius/api-client/sdk";
import {
  HEADER_LOGO_WIDTH_DEFAULT,
  HEADER_LOGO_WIDTH_MAX,
  HEADER_LOGO_WIDTH_MIN,
  HEADER_LOGO_WIDTH_STEP,
} from "@scalius/shared/brand-presentation";
import {
  STOREFRONT_DENSITIES,
  STOREFRONT_LISTING_FILTER_STYLES,
  STOREFRONT_THEME_MIN_CONTRAST,
  isStorefrontThemeHexColor,
  storefrontBlockDefault,
  storefrontBlockVariants,
  storefrontSectionRenderer,
  storefrontVariantSpec,
  type FitCondition,
  type ResolvedStorefrontThemeLayout,
  type StoreShape,
  type StorefrontFitFacts,
  type StorefrontTemplateId,
  type StorefrontThemeDocument,
  type StorefrontThemeFallback,
  type StorefrontListingFilterStyle,
} from "@scalius/shared/storefront-theme";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { SaveBarProvider, useServerFieldError } from "~/components/admin/shared/SaveBar";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { apiData } from "~/lib/api";
import {
  footerQueryOptions,
  headerQueryOptions,
  themeQueryOptions,
} from "~/lib/api-query-options/online-store";
import { formatNumber, useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { ImageField } from "./ImageField";
import { OnlineStorePage, SectionCard, failSave, useDocumentDraft } from "./shared";
import {
  CardStyleSketch,
  DensitySketch,
  FooterSketch,
  HeaderRows,
  HeaderSketch,
  BuyBoxSketch,
  MobileNavigationSketch,
  NavigationSketch,
  ProductPageSketch,
  ProductTile,
  Sketch,
  VisualChoice,
} from "./ThemeChoices";
import { SectionEditor, type SectionMediaPreview } from "./SectionEditor";
import { TypographyCard } from "./TypographyCard";
import {
  COLOR_FIELD_IDS,
  COLOR_ROLE_TOKEN,
  TEMPLATE_THEMES,
  applyTemplate,
  blockFallback,
  blockVariant,
  colorFieldForPath,
  resolveThemeForStore,
  selectedTemplate,
  setBlockVariant,
  setThemeColor,
  themeContrastProblems,
  themeDraftInvalid,
  type ColorRole,
  type ContrastProblem,
  type ThemeBlockSlot,
} from "./theme-settings";

type Theme = StorefrontThemeDocument;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** What a block variant renders today, for its picker sketch. */
function variantRenders<Render>(slot: ThemeBlockSlot, variant: string): Render {
  const spec = storefrontVariantSpec(slot, variant);
  return (spec.renders as (settings: unknown) => Render)(spec.defaults);
}

/** A template's whole look in its own colours: header shape and product cards, as this store renders them. */
function TemplatePreview({ theme, layout }: { theme: Theme; layout: ResolvedStorefrontThemeLayout }) {
  const { colors, radius } = theme.tokens;
  return (
    <Sketch
      palette={{
        paper: colors.background,
        ink: colors.foreground,
        line: colors["muted-foreground"],
        soft: colors.muted,
        edge: colors.border,
        accent: colors.primary,
      }}
      className="h-28"
    >
      {theme.template === "marketplace" ? (
        <span
          data-marketplace-preview
          style={{ "--sk-purchase": colors.accent } as CSSProperties}
          className="flex min-h-0 flex-1 flex-col gap-1"
        >
          <span data-marketplace-header className="flex h-7 shrink-0 flex-col gap-1 rounded-xs bg-(--sk-ink) p-1">
            <span className="flex items-center gap-1">
              <span className="h-1 w-4 bg-(--sk-paper)" />
              <span className="flex h-2 flex-1 overflow-clip rounded-xs bg-(--sk-paper)">
                <span className="ml-auto w-2 bg-(--sk-purchase)" />
              </span>
              <span className="size-1 rounded-full bg-(--sk-paper)" />
              <span className="size-1 rounded-full bg-(--sk-paper)" />
            </span>
            <span className="flex gap-1">
              <span className="h-0.5 w-4 bg-(--sk-paper)" />
              <span className="h-0.5 w-3 bg-(--sk-paper)" />
              <span className="h-0.5 w-3 bg-(--sk-paper)" />
            </span>
          </span>
          <span className="flex min-h-0 flex-1 gap-1">
            <span data-marketplace-category-grid className="grid min-w-0 flex-1 grid-cols-2 gap-1 border-r border-(--sk-edge) pr-1">
              {[0, 1, 2, 3].map((index) => (
                <span key={index} className="flex min-h-0 flex-col gap-0.5 rounded-xs border border-(--sk-edge) p-0.5">
                  <span className="min-h-0 flex-1 bg-(--sk-soft)" />
                  <span className="h-0.5 w-3/4 bg-(--sk-line)" />
                  <span className="h-0.5 w-1/2 bg-(--sk-ink)" />
                </span>
              ))}
            </span>
            <span data-marketplace-search-list className="flex min-w-0 flex-1 flex-col gap-1">
              {[0, 1].map((index) => (
                <span key={index} data-marketplace-result-row className="flex min-h-0 flex-1 gap-1 border-b border-(--sk-edge) pb-0.5 last:border-0">
                  <span className="aspect-square h-full max-h-7 shrink-0 rounded-xs bg-(--sk-soft)" />
                  <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                    <span className="h-1 w-4/5 bg-(--sk-line)" />
                    <span className="h-0.5 w-2/3 bg-(--sk-line)" />
                    <span className="h-1 w-1/3 bg-(--sk-ink)" />
                    <span className="h-1 w-1/2 rounded-full bg-(--sk-purchase)" />
                  </span>
                </span>
              ))}
            </span>
          </span>
        </span>
      ) : (
        <>
          <HeaderRows kind={layout.header} />
          <span className="mt-1 flex justify-center gap-1.5">
            {[0, 1, 2].map((index) => (
              <ProductTile key={index} card={layout.productCard} radius={radius} badge={index === 0} className="max-w-11" />
            ))}
          </span>
        </>
      )}
    </Sketch>
  );
}

function ListingLayoutSketch({ layout, theme }: { layout: "grid" | "list"; theme: Theme }) {
  const { colors } = theme.tokens;
  return (
    <Sketch palette={{
      paper: colors.background,
      ink: colors.foreground,
      line: colors["muted-foreground"],
      soft: colors.muted,
      edge: colors.border,
      accent: colors.primary,
    }} className="h-16">
      <span data-listing-layout-sketch={layout} className={layout === "grid" ? "grid min-h-0 flex-1 grid-cols-3 gap-1" : "flex min-h-0 flex-1 flex-col gap-1"}>
        {[0, 1, 2].map((index) => (
          <span key={index} className={layout === "grid" ? "flex min-h-0 flex-col gap-0.5 rounded-xs border border-(--sk-edge) p-0.5" : "flex min-h-0 flex-1 gap-1 border-b border-(--sk-edge) pb-0.5 last:border-0"}>
            <span className={layout === "grid" ? "min-h-0 flex-1 bg-(--sk-soft)" : "aspect-square h-full shrink-0 bg-(--sk-soft)"} />
            <span className={layout === "grid" ? "h-0.5 w-3/4 bg-(--sk-ink)" : "flex min-w-0 flex-1 flex-col justify-center gap-0.5"}>
              {layout === "list" && <><span className="h-0.5 w-4/5 bg-(--sk-line)" /><span className="h-0.5 w-1/3 bg-(--sk-ink)" /></>}
            </span>
          </span>
        ))}
      </span>
    </Sketch>
  );
}

function ListingFilterSketch({ filterStyle, theme }: { filterStyle: StorefrontListingFilterStyle; theme: Theme }) {
  const colors = theme.tokens.colors;
  const sidebar = filterStyle.startsWith("sidebar");
  return (
    <Sketch palette={{ paper: colors.background, ink: colors.foreground, line: colors["muted-foreground"], soft: colors.muted, edge: colors.border, accent: colors.primary }} className="h-16">
      <span data-listing-filter-sketch={filterStyle} className="flex min-h-0 flex-1 flex-col gap-1">
        {!sidebar && <span className="flex h-3 gap-1 border-b border-(--sk-edge) pb-1">
          {(filterStyle === "drawer" ? [0] : [0, 1, 2]).map((item) => <span key={item} className="w-1/4 rounded-full bg-(--sk-soft)" />)}
        </span>}
        <span className="flex min-h-0 flex-1 gap-1">
          {sidebar && <span className="flex w-1/3 flex-col gap-1 border-r border-(--sk-edge) pr-1">
            {[0, 1, 2, 3].map((item) => <span key={item} className="h-1 rounded-full bg-(--sk-line)" />)}
          </span>}
          <span className="grid min-w-0 flex-1 grid-cols-3 gap-1">
            {[0, 1, 2].map((item) => <span key={item} className="rounded-xs bg-(--sk-soft)" />)}
          </span>
        </span>
      </span>
    </Sketch>
  );
}

/** Ratios round down, so "4.4:1" never reads as the 4.5:1 it misses. */
const formatRatio = (ratio: number) =>
  formatNumber(Math.floor(ratio * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function ColorField({
  role,
  label,
  value,
  problems,
  onChange,
}: {
  role: ColorRole;
  label: string;
  value: string;
  /** Text this colour leaves below AA, in plain words. */
  problems: readonly ContrastProblem[];
  onChange: (value: string) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const id = COLOR_FIELD_IDS[role];
  const valid = isStorefrontThemeHexColor(value);
  const [left, setLeft] = useState(false);
  const server = useServerFieldError(id);
  const errors = [
    server.error ?? (!valid && (left || server.revealed) ? t("colorInvalid") : undefined),
    ...problems.map((problem) => t(problem.message, {
      ratio: formatRatio(problem.ratio),
      min: formatRatio(STOREFRONT_THEME_MIN_CONTRAST),
    })),
  ].filter((error): error is string => Boolean(error));
  const change = (next: string) => {
    server.clear();
    // The document stores lowercase #rrggbb.
    onChange(next.trim().toLowerCase());
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <label
          style={{ "--swatch": valid ? value : "transparent" } as CSSProperties}
          className="relative size-11 shrink-0 cursor-pointer rounded-lg border bg-(--swatch) sm:size-9"
        >
          <span className="sr-only">{t("pickColor", { name: label })}</span>
          <input
            type="color"
            value={valid ? value : "#000000"}
            onChange={(event) => change(event.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
        <Input
          id={id}
          value={value}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={errors.length > 0 ? true : undefined}
          aria-describedby={errors.length > 0 ? `${id}-note` : undefined}
          onBlur={() => setLeft(true)}
          onChange={(event) => change(event.target.value)}
        />
      </div>
      {errors.length > 0 ? (
        <div id={`${id}-note`} role="alert" className="space-y-1">
          {errors.map((error) => <p key={error} className="text-body text-destructive">{error}</p>)}
        </div>
      ) : null}
    </div>
  );
}

function SwitchField({
  id,
  label,
  help,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  help: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-note`} className="text-body text-muted-foreground">{help}</p>
      </div>
      <span className="flex h-lh items-center">
        <Switch id={id} checked={checked} aria-describedby={`${id}-note`} onCheckedChange={onCheckedChange} />
      </span>
    </div>
  );
}

/** Header and footer documents: logos, favicon and the announcement bar switch. */
function useSiteDrafts() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const header = useSuspenseQuery(headerQueryOptions());
  const footer = useSuspenseQuery(footerQueryOptions());
  const headerDraft = useDocumentDraft({
    label: t("header"),
    saved: header.data.config,
    save: async (config) => {
      try {
        const saved = await apiData(postApiV1AdminSettingsHeader({
          body: { ...config, expectedRevision: header.data.revision },
        }));
        queryClient.setQueryData(headerQueryOptions().queryKey, { config, revision: saved.revision });
      } catch (error) {
        failSave(error, () => void header.refetch());
      }
    },
  });
  const footerDraft = useDocumentDraft({
    label: t("footer"),
    saved: footer.data.config,
    save: async (config) => {
      try {
        const saved = await apiData(postApiV1AdminSettingsFooter({
          body: { ...config, expectedRevision: footer.data.revision },
        }));
        queryClient.setQueryData(footerQueryOptions().queryKey, { config, revision: saved.revision });
      } catch (error) {
        failSave(error, () => void footer.refetch());
      }
    },
  });
  return { headerDraft, footerDraft };
}

type SiteDrafts = ReturnType<typeof useSiteDrafts>;

function LogoCard({ headerDraft, footerDraft }: SiteDrafts) {
  const t = useMessages(onlineStoreMessages);
  const logo = headerDraft.draft.logo;
  const logoWidth = logo.width ?? HEADER_LOGO_WIDTH_DEFAULT;

  return (
    <SectionCard title={t("logo")}>
      <ImageField
        label={t("headerLogo")}
        src={logo.src}
        wide
        onChange={(image) => headerDraft.setDraft((config) => ({
          ...config,
          logo: { ...config.logo, src: image.src, alt: config.logo.alt || image.alt },
        }))}
      />
      {logo.src ? (
        <div className="space-y-1.5">
          <Label htmlFor="theme-logo-width">{t("logoWidth", { width: logoWidth })}</Label>
          <input
            id="theme-logo-width"
            type="range"
            min={HEADER_LOGO_WIDTH_MIN}
            max={HEADER_LOGO_WIDTH_MAX}
            step={HEADER_LOGO_WIDTH_STEP}
            value={logoWidth}
            onChange={(event) => headerDraft.setDraft((config) => ({
              ...config,
              logo: { ...config.logo, width: Number(event.target.value) },
            }))}
            className="h-11 w-full accent-primary sm:h-6"
            aria-valuetext={`${logoWidth}px`}
          />
        </div>
      ) : null}
      <ImageField
        label={t("footerLogo")}
        src={footerDraft.draft.logo.src}
        wide
        onChange={(image) => footerDraft.setDraft((config) => ({
          ...config,
          logo: { src: image.src, alt: config.logo.alt || image.alt },
        }))}
      />
      <ImageField
        label={t("favicon")}
        src={headerDraft.draft.favicon.src}
        onChange={(image) => headerDraft.setDraft((config) => ({ ...config, favicon: image }))}
      />
    </SectionCard>
  );
}

const COLOR_FIELDS: ReadonlyArray<{ role: ColorRole; label: MessageKey }> = [
  { role: "background", label: "colorBackground" },
  { role: "text", label: "colorText" },
  { role: "buttons", label: "colorButtons" },
  { role: "buttonText", label: "colorButtonText" },
];

/**
 * A fit condition in plain words: what the store needs for a choice to show
 * as chosen, with the value the resolver judged it on (the store shape plus
 * the navigation the header renders).
 */
function useFitReason(facts: StorefrontFitFacts) {
  const t = useMessages(onlineStoreMessages);
  const option = (key: string) => t(key as MessageKey);
  const reason = (condition: FitCondition): string => {
    if ("anyOf" in condition) return condition.anyOf.map(reason).join(" ");
    if ("block" in condition) return t("fitNeedsCard", { name: option(`cardStyle_${condition.variants[0]}`) });
    const what = option(`fact_${condition.fact}`);
    if ("equals" in condition) return t("fitNeeds", { what });
    const value = formatNumber(facts[condition.fact]);
    if (condition.min !== undefined && condition.max !== undefined) {
      return t("fitBetween", { what, min: formatNumber(condition.min), max: formatNumber(condition.max), value });
    }
    if (condition.max !== undefined) return t("fitAtMost", { what, max: formatNumber(condition.max), value });
    return t("fitAtLeast", { what, min: formatNumber(condition.min ?? 0), value });
  };
  return (fallback: Pick<StorefrontThemeFallback, "failed">) => fallback.failed.map(reason).join(" ");
}

/** Under a picker: the choice does not fit this store, what shows instead and why. */
function FitNote({ fallback, name, reason }: {
  fallback: StorefrontThemeFallback | null;
  name: (variant: string) => string;
  reason: (fallback: StorefrontThemeFallback) => string;
}) {
  const t = useMessages(onlineStoreMessages);
  if (!fallback?.resolved) return null;
  return (
    <p role="status" className="text-body text-muted-foreground">
      {t("fitShowsInstead", { name: name(fallback.resolved), reason: reason(fallback) })}
    </p>
  );
}

/**
 * The theme, card by card. Choices are resolved against the store's shape
 * with the storefront's own resolver, so a choice that does not fit the
 * store says what buyers see instead.
 */
function ThemeCards({ saved, revision, storeShape, sectionMedia, refetch, site }: {
  saved: Theme;
  revision: number;
  storeShape: StoreShape;
  sectionMedia: readonly SectionMediaPreview[];
  refetch: () => unknown;
  site: SiteDrafts;
}) {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const { draft: theme, setDraft } = useDocumentDraft<Theme>({
    label: t("themeTitle"),
    saved,
    fields: (path) => colorFieldForPath(path),
    invalid: themeDraftInvalid,
    save: async (next) => {
      try {
        const result = await apiData(postApiV1AdminSettingsTheme({
          body: { expectedRevision: revision, theme: next },
        }));
        queryClient.setQueryData(themeQueryOptions().queryKey, (previous) => previous && {
          ...previous,
          theme: result.theme,
          revision: result.revision,
        });
      } catch (error) {
        failSave(error, () => void refetch());
      }
    },
  });
  const option = (key: string) => t(key as MessageKey);
  const resolved = resolveThemeForStore(theme, storeShape);
  const fitReason = useFitReason(resolved.facts);
  const problems = themeContrastProblems(theme);
  const { headerDraft } = site;
  // A changed theme matches no template: say which one it is based on, and
  // confirm before another template replaces the merchant's changes.
  const selected = selectedTemplate(theme);
  const [pendingTemplate, setPendingTemplate] = useState<StorefrontTemplateId | null>(null);
  const chooseTemplate = (id: StorefrontTemplateId) => {
    if (selected === null) setPendingTemplate(id);
    else setDraft(applyTemplate(id));
  };
  const setBlock = (slot: ThemeBlockSlot) => (variant: string) =>
    setDraft((current) => setBlockVariant(current, slot, variant));
  const blockOptions = <Render,>(slot: ThemeBlockSlot, prefix: string, sketch: (render: Render, variant: string) => ReactNode, help = false) =>
    storefrontBlockVariants(slot).map((value) => ({
      value,
      label: option(`${prefix}_${value}`),
      help: help ? option(`${prefix}_${value}Help`) : undefined,
      sketch: sketch(variantRenders<Render>(slot, value), value),
    }));
  const fitNote = (slot: ThemeBlockSlot, prefix: string) => (
    <FitNote
      fallback={blockFallback(resolved, slot)}
      name={(variant) => option(`${prefix}_${variant}`)}
      reason={fitReason}
    />
  );
  const sectionNotes = Object.fromEntries(theme.pages.home.flatMap((section) => {
    if (storefrontSectionRenderer(section) === null) return [[section.id, t("sectionNotYet")]];
    const fallback = resolved.fallbacks.find((each) => each.kind === "section" && each.key === section.id);
    return fallback ? [[section.id, t("sectionHidden", { reason: fitReason(fallback) })]] : [];
  }));

  return (
    <>
      <SectionCard title={t("themeTemplates")} description={t("themeTemplatesHelp")}>
        {selected === null ? (
          <p className="text-body text-muted-foreground" role="status">
            {t("templateCustomBasedOn", { name: option(`template_${theme.template}`) })}
          </p>
        ) : null}
        <VisualChoice
          label={t("themeTemplates")}
          value={selected}
          className="grid-cols-2 sm:grid-cols-3"
          options={TEMPLATE_THEMES.map((template) => ({
            value: template.id,
            label: option(`template_${template.id}`),
            help: option(`template_${template.id}Help`),
            sketch: <TemplatePreview theme={template.theme} layout={resolveThemeForStore(template.theme, storeShape).layout} />,
          }))}
          onChange={chooseTemplate}
        />
        <ConfirmDialog
          open={pendingTemplate !== null}
          onOpenChange={(open) => { if (!open) setPendingTemplate(null); }}
          title={t("templateReplaceTitle", { name: pendingTemplate ? option(`template_${pendingTemplate}`) : "" })}
          description={t("templateReplaceBody")}
          confirmLabel={t("templateReplaceConfirm")}
          variant="default"
          onConfirm={() => {
            const id = pendingTemplate;
            setPendingTemplate(null);
            if (id) setDraft(applyTemplate(id));
          }}
        />
      </SectionCard>

      <LogoCard {...site} />

      <SectionCard title={t("colors")}>
        <div className="grid gap-4 sm:grid-cols-2">
          {COLOR_FIELDS.map(({ role, label }) => (
            <ColorField
              key={role}
              role={role}
              label={t(label)}
              value={theme.tokens.colors[COLOR_ROLE_TOKEN[role]]}
              problems={problems.filter((problem) => problem.role === role)}
              onChange={(value) => setDraft((current) => setThemeColor(current, role, value))}
            />
          ))}
        </div>
      </SectionCard>

      <TypographyCard theme={theme} setDraft={setDraft} />

      <SectionCard title={t("header")}>
        <VisualChoice
          label={t("header")}
          value={blockVariant(theme, "header")}
          className="grid-cols-2 sm:grid-cols-4"
          options={blockOptions<ResolvedStorefrontThemeLayout["header"]>("header", "header", (kind, variant) => <HeaderSketch kind={kind} variant={variant} />)}
          onChange={setBlock("header")}
        />
        {fitNote("header", "header")}
        <SwitchField
          id="theme-announcement-bar"
          label={t("announcementBar")}
          help={
            <>
              {t("announcementBarHelp")}{" "}
              <Link to="/admin/online-store/navigation" className="text-link hover:underline">
                {t("editAnnouncement")}
              </Link>
            </>
          }
          checked={headerDraft.draft.topBar.isEnabled === true}
          onCheckedChange={(isEnabled) =>
            headerDraft.setDraft((config) => ({ ...config, topBar: { ...config.topBar, isEnabled } }))}
        />
      </SectionCard>

      <SectionCard
        title={t("menuStyle")}
        description={
          <>
            {t("menuStyleHelp")}{" "}
            <Link to="/admin/online-store/navigation" className="text-link hover:underline">
              {t("editMenus")}
            </Link>
          </>
        }
      >
        <VisualChoice
          label={t("menuStyleDesktop")}
          showLabel
          value={blockVariant(theme, "desktopNav")}
          className="grid-cols-2 sm:grid-cols-3"
          options={blockOptions<ResolvedStorefrontThemeLayout["navigation"]>("desktopNav", "navigation", (kind) => <NavigationSketch kind={kind} />, true)}
          onChange={setBlock("desktopNav")}
        />
        {fitNote("desktopNav", "navigation")}
        <VisualChoice
          label={t("menuStylePhone")}
          showLabel
          value={blockVariant(theme, "mobileNav")}
          className="grid-cols-2 sm:grid-cols-3"
          options={blockOptions<ResolvedStorefrontThemeLayout["mobileNavigation"]>("mobileNav", "mobileNavigation", (kind) => <MobileNavigationSketch kind={kind} />, true)}
          onChange={setBlock("mobileNav")}
        />
      </SectionCard>

      <SectionCard title={t("footer")} description={t("footerLayoutHelp")}>
        <VisualChoice
          label={t("footer")}
          value={blockVariant(theme, "footer")}
          options={blockOptions<ResolvedStorefrontThemeLayout["footer"]>("footer", "footer", (kind) => <FooterSketch kind={kind} />)}
          onChange={setBlock("footer")}
        />
        {fitNote("footer", "footer")}
      </SectionCard>

      <SectionCard title={t("productCards")}>
        <VisualChoice
          label={t("productCards")}
          value={blockVariant(theme, "card")}
          className="sm:grid-cols-3"
          options={blockOptions<Omit<ResolvedStorefrontThemeLayout["productCard"], "imageRatio">>("card", "cardStyle", (card) => (
            <CardStyleSketch card={{ ...card, imageRatio: resolved.layout.productCard.imageRatio }} />
          ), true)}
          onChange={setBlock("card")}
        />
      </SectionCard>

      {(theme.blocks.listing.layout.variant === "grid" || theme.blocks.listing.layout.variant === "list") && (
        <SectionCard title={t("listingDefault")} description={t("listingDefaultHelp")}>
          <div data-listing-default className="space-y-4">
            <VisualChoice
              label={t("listingDefault")}
              value={theme.blocks.listing.layout.variant === "grid" || theme.blocks.listing.layout.variant === "list"
                ? theme.blocks.listing.layout.variant
                : null}
              className="grid-cols-2"
              options={(["grid", "list"] as const).map((layout) => ({
                value: layout,
                label: t(layout === "grid" ? "listingGrid" : "listingList"),
                sketch: <ListingLayoutSketch layout={layout} theme={theme} />,
              }))}
              onChange={(layout) => setDraft((current) => ({
                ...current,
                blocks: {
                  ...current.blocks,
                  listing: {
                    ...current.blocks.listing,
                    layout: storefrontBlockDefault("listing", layout) as Theme["blocks"]["listing"]["layout"],
                  },
                },
              }))}
            />
            <SwitchField
              id="theme-listing-view-toggle"
              label={t("listingViewSwitch")}
              help={t("listingViewSwitchHelp")}
              checked={theme.blocks.listing.toolbar.includes("grid-list-toggle")}
              onCheckedChange={(checked) => setDraft((current) => ({
                ...current,
                blocks: {
                  ...current.blocks,
                  listing: {
                    ...current.blocks.listing,
                    toolbar: checked
                      ? [...current.blocks.listing.toolbar, "grid-list-toggle"]
                      : current.blocks.listing.toolbar.filter((piece) => piece !== "grid-list-toggle"),
                  },
                },
              }))}
            />
            {theme.template === "marketplace" && <p className="text-body text-muted-foreground">{t("listingMarketplaceHelp")}</p>}
          </div>
        </SectionCard>
      )}

      <SectionCard title={t("listingFilters")} description={t("listingFiltersHelp")}>
        <div data-listing-filter-style>
          <VisualChoice
            label={t("listingFilters")}
            value={theme.blocks.listing.filters.style}
            className="grid-cols-2 sm:grid-cols-4"
            options={STOREFRONT_LISTING_FILTER_STYLES.map((style) => ({
              value: style,
              label: t(({
                "sidebar-dense": "filterStyle_dense",
                "sidebar-comfortable": "filterStyle_comfortable",
                "bar-dropdowns": "filterStyle_bar",
                drawer: "filterStyle_drawer",
              } as const)[style]),
              sketch: <ListingFilterSketch filterStyle={style} theme={theme} />,
            }))}
            onChange={(style) => setDraft((current) => ({
              ...current,
              blocks: {
                ...current.blocks,
                listing: {
                  ...current.blocks.listing,
                  filters: {
                    ...current.blocks.listing.filters,
                    style,
                    openByDefault: style === "sidebar-dense" || style === "sidebar-comfortable",
                  },
                },
              },
            }))}
          />
        </div>
      </SectionCard>

      <SectionCard title={t("density")} description={t("densityHelp")}>
        <VisualChoice
          label={t("density")}
          value={theme.tokens.density}
          className="grid-cols-2"
          options={STOREFRONT_DENSITIES.map((value) => ({
            value,
            label: option(`density_${value}`),
            help: option(`density_${value}Help`),
            sketch: <DensitySketch density={value} />,
          }))}
          onChange={(density) => setDraft((current) => ({ ...current, tokens: { ...current.tokens, density } }))}
        />
      </SectionCard>

      <SectionCard title={t("productPage")}>
        <VisualChoice
          label={t("productPage")}
          value={blockVariant(theme, "gallery")}
          options={blockOptions<ResolvedStorefrontThemeLayout["productPage"]>("gallery", "productPage", (layout) => <ProductPageSketch layout={layout} />)}
          onChange={setBlock("gallery")}
        />
      </SectionCard>

      <SectionCard title={t("purchasePanel")}>
        <VisualChoice
          label={t("purchasePanel")}
          value={blockVariant(theme, "buyBox")}
          className="grid-cols-2 sm:grid-cols-4"
          options={blockOptions<ResolvedStorefrontThemeLayout["buyBox"]>("buyBox", "buyBox", (box) => <BuyBoxSketch box={box} />)}
          onChange={setBlock("buyBox")}
        />
        {fitNote("buyBox", "buyBox")}
      </SectionCard>

      <SectionCard
        title={t("homepageSections")}
        description={t("homepageSectionsHelp")}
        rows={
          <SectionEditor
            sections={theme.pages.home}
            notes={sectionNotes}
            media={sectionMedia}
            onChange={(home) => setDraft((current) => ({ ...current, pages: { ...current.pages, home } }))}
          />
        }
      />
    </>
  );
}

function ThemeSettings() {
  const { data, refetch } = useSuspenseQuery(themeQueryOptions());
  const site = useSiteDrafts();
  return (
    <ThemeCards
      saved={data.theme as Theme}
      revision={data.revision}
      storeShape={data.storeShape as StoreShape}
      sectionMedia={data.sectionMedia}
      refetch={refetch}
      site={site}
    />
  );
}

export function ThemePage() {
  const t = useMessages(onlineStoreMessages);
  return (
    <SaveBarProvider>
      <OnlineStorePage title={t("themeTitle")}>
        <ThemeSettings />
      </OnlineStorePage>
    </SaveBarProvider>
  );
}
