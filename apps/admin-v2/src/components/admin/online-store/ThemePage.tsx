import { useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Info } from "lucide-react";
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
  STOREFRONT_CARD_STYLES,
  STOREFRONT_DENSITIES,
  STOREFRONT_FOOTER_STYLES,
  STOREFRONT_HEADER_STYLES,
  STOREFRONT_PRODUCT_PAGE_LAYOUTS,
  STOREFRONT_THEME_MIN_CONTRAST,
  isStorefrontThemeHexColor,
  type StorefrontStylePresetKey,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
  HomepageOrder,
  ProductPageSketch,
  ProductTile,
  Sketch,
  VisualChoice,
} from "./ThemeChoices";
import {
  COLOR_FIELD_IDS,
  COLOR_ROLE_TOKEN,
  STYLE_PRESET_THEMES,
  applyStylePreset,
  closestStylePreset,
  colorFieldForPath,
  selectedStylePreset,
  setThemeColor,
  themeContrastProblems,
  themeDraftInvalid,
  type ColorRole,
  type ContrastProblem,
} from "./theme-settings";

type Theme = StorefrontThemeDocument;
type Layout = Theme["layout"];
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** A Style's whole look in its own colours: header shape and product cards. */
function StylePreview({ theme }: { theme: Theme }) {
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
      <HeaderRows kind={theme.layout.header} />
      <span className="mt-1 flex justify-center gap-1.5">
        {[0, 1, 2].map((index) => (
          <ProductTile key={index} card={theme.layout.card} radius={radius} badge={index === 0} className="max-w-11" />
        ))}
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
 * The configured theme, card by card. Only this component registers the theme
 * document with the save bar, so a custom design is never offered for saving.
 */
function ConfiguredThemeCards({ saved, revision, refetch, site }: {
  saved: Theme;
  revision: number;
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
        queryClient.setQueryData(themeQueryOptions().queryKey, {
          theme: result.theme,
          revision: result.revision,
        });
      } catch (error) {
        failSave(error, () => void refetch());
      }
    },
  });
  const option = (key: string) => t(key as MessageKey);
  const setLayout = (layout: Partial<Layout>) =>
    setDraft((current) => ({ ...current, layout: { ...current.layout, ...layout } }));
  const { layout } = theme;
  const problems = themeContrastProblems(theme.tokens.colors);
  const { headerDraft } = site;
  // A fine-tuned theme matches no Style: say which one it started from, and
  // confirm before another Style replaces the merchant's changes.
  const selectedPreset = selectedStylePreset(theme);
  const basePreset = selectedPreset ?? closestStylePreset(theme);
  const [pendingPreset, setPendingPreset] = useState<StorefrontStylePresetKey | null>(null);
  const choosePreset = (key: StorefrontStylePresetKey) => {
    if (selectedPreset === null) setPendingPreset(key);
    else setDraft((current) => applyStylePreset(current, key));
  };

  return (
    <>
      <SectionCard title={t("themeStyles")} description={t("themeStylesHelp")}>
        {selectedPreset === null ? (
          <p className="text-body text-muted-foreground" role="status">
            {t("styleCustomBasedOn", { name: option(`preset_${basePreset}`) })}
          </p>
        ) : null}
        <VisualChoice
          label={t("themeStyles")}
          value={selectedPreset}
          className="grid-cols-2 sm:grid-cols-3"
          options={STYLE_PRESET_THEMES.map((preset) => ({
            value: preset.key,
            label: option(`preset_${preset.key}`),
            help: option(`preset_${preset.key}Help`),
            sketch: <StylePreview theme={preset.theme} />,
          }))}
          onChange={choosePreset}
        />
        <ConfirmDialog
          open={pendingPreset !== null}
          onOpenChange={(open) => { if (!open) setPendingPreset(null); }}
          title={t("styleReplaceTitle", { name: pendingPreset ? option(`preset_${pendingPreset}`) : "" })}
          description={t("styleReplaceBody")}
          confirmLabel={t("styleReplaceConfirm")}
          variant="default"
          onConfirm={() => {
            const key = pendingPreset;
            setPendingPreset(null);
            if (key) setDraft((current) => applyStylePreset(current, key));
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

      <SectionCard title={t("header")}>
        <VisualChoice
          label={t("header")}
          value={layout.header}
          options={STOREFRONT_HEADER_STYLES.map((value) => ({
            value,
            label: option(`header_${value}`),
            sketch: <HeaderSketch kind={value} />,
          }))}
          onChange={(header) => setLayout({ header })}
        />
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

      <SectionCard title={t("footer")} description={t("footerLayoutHelp")}>
        <VisualChoice
          label={t("footer")}
          value={layout.footer}
          options={STOREFRONT_FOOTER_STYLES.map((value) => ({
            value,
            label: option(`footer_${value}`),
            sketch: <FooterSketch kind={value} />,
          }))}
          onChange={(footer) => setLayout({ footer })}
        />
      </SectionCard>

      <SectionCard title={t("productCards")}>
        <VisualChoice
          label={t("productCards")}
          value={layout.card}
          className="sm:grid-cols-3"
          options={STOREFRONT_CARD_STYLES.map((value) => ({
            value,
            label: option(`cardStyle_${value}`),
            help: option(`cardStyle_${value}Help`),
            sketch: <CardStyleSketch card={value} />,
          }))}
          onChange={(card) => setLayout({ card })}
        />
      </SectionCard>

      <SectionCard title={t("density")} description={t("densityHelp")}>
        <VisualChoice
          label={t("density")}
          value={layout.density}
          className="grid-cols-2"
          options={STOREFRONT_DENSITIES.map((value) => ({
            value,
            label: option(`density_${value}`),
            help: option(`density_${value}Help`),
            sketch: <DensitySketch density={value} />,
          }))}
          onChange={(density) => setLayout({ density })}
        />
      </SectionCard>

      <SectionCard title={t("productPage")}>
        <VisualChoice
          label={t("productPage")}
          value={layout.productPage}
          options={STOREFRONT_PRODUCT_PAGE_LAYOUTS.map((value) => ({
            value,
            label: option(`productPage_${value}`),
            sketch: <ProductPageSketch layout={value} />,
          }))}
          onChange={(productPage) => setLayout({ productPage })}
        />
      </SectionCard>

      <SectionCard
        title={t("homepageSections")}
        description={t("homepageSectionsHelp")}
        rows={
          <HomepageOrder
            sections={theme.sections}
            onChange={(sections) => setDraft((current) => ({ ...current, sections }))}
          />
        }
      />
    </>
  );
}

function ThemeCards() {
  const t = useMessages(onlineStoreMessages);
  const { data, refetch } = useSuspenseQuery(themeQueryOptions());
  const site = useSiteDrafts();
  if (data.theme.mode === "custom") {
    return (
      <>
        <Alert variant="info">
          <Info aria-hidden="true" />
          <AlertDescription>{t("customDesign")}</AlertDescription>
        </Alert>
        <LogoCard {...site} />
      </>
    );
  }
  return <ConfiguredThemeCards saved={data.theme} revision={data.revision} refetch={refetch} site={site} />;
}

export function ThemePage() {
  const t = useMessages(onlineStoreMessages);
  return (
    <SaveBarProvider>
      <OnlineStorePage title={t("themeTitle")}>
        <ThemeCards />
      </OnlineStorePage>
    </SaveBarProvider>
  );
}
