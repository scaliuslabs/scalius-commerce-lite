import { useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
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
  DEFAULT_STOREFRONT_THEME_COLORS,
  STOREFRONT_CARD_BADGE_PLACEMENTS,
  STOREFRONT_CARD_IMAGE_RATIOS,
  STOREFRONT_FOOTER_STYLES,
  STOREFRONT_GRID_DESKTOP_COLUMNS,
  STOREFRONT_GRID_MOBILE_COLUMNS,
  STOREFRONT_HEADER_STYLES,
  STOREFRONT_PRODUCT_GALLERY_LAYOUTS,
  STOREFRONT_PRODUCT_THUMBNAIL_PLACEMENTS,
  STOREFRONT_THEME_BODY_FONTS,
  STOREFRONT_THEME_BUTTON_STYLES,
  STOREFRONT_THEME_CARD_STYLES,
  STOREFRONT_THEME_CONTAINER_WIDTHS,
  STOREFRONT_THEME_CORNER_STYLES,
  STOREFRONT_THEME_DENSITIES,
  STOREFRONT_THEME_HEADING_FONTS,
  STOREFRONT_THEME_INPUT_STYLES,
  STOREFRONT_THEME_TYPE_SCALES,
  isSafeStorefrontThemeColorValue,
  storefrontStylePresetTheme,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";
import { cn } from "@scalius/shared/utils";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { SaveBarProvider, useServerFieldError } from "~/components/admin/shared/SaveBar";
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
  CardSketch,
  FooterSketch,
  GallerySketch,
  HeaderRows,
  HeaderSketch,
  HomepageOrder,
  ProductTile,
  SegmentedChoice,
  Sketch,
  ThumbnailSketch,
  VisualChoice,
} from "./ThemeChoices";
import { STYLE_PRESET_THEMES, selectedStylePreset } from "./theme-settings";

type Theme = StorefrontThemeSettings;
type Layout = Theme["layout"];
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

const COLOR_FIELD_IDS: Record<string, string> = {
  background: "theme-color-background",
  foreground: "theme-color-text",
  primary: "theme-color-buttons",
  "primary-foreground": "theme-color-button-text",
};

/** Each merchant colour writes the storefront tokens that share its role. */
const COLOR_ROLES = {
  background: ["background", "card", "popover"],
  text: ["foreground", "card-foreground", "popover-foreground"],
  buttons: ["primary", "ring"],
  buttonText: ["primary-foreground"],
} as const;

function colorValue(theme: Theme, token: string): string {
  return theme.colors[token] ?? DEFAULT_STOREFRONT_THEME_COLORS[token] ?? "";
}

/** A Style's whole look in its own colours: header shape and product cards. */
function StylePreview({ theme }: { theme: Theme }) {
  const { layout } = theme;
  return (
    <Sketch
      palette={{
        paper: colorValue(theme, "background"),
        ink: colorValue(theme, "foreground"),
        line: colorValue(theme, "muted-foreground"),
        soft: colorValue(theme, "muted"),
        edge: colorValue(theme, "border"),
        accent: colorValue(theme, "primary"),
      }}
      className="h-28"
    >
      <HeaderRows kind={layout.header} />
      <span className="mt-1 flex justify-center gap-1.5">
        {[0, 1, 2].map((index) => (
          <ProductTile
            key={index}
            ratio={layout.productCard.imageRatio}
            badge={index === 0 ? layout.productCard.badge : undefined}
            corners={theme.cornerStyle}
            className="max-w-11"
          />
        ))}
      </span>
    </Sketch>
  );
}

/** The browser resolves any CSS colour; read it back as #rrggbb. */
function toHex(color: string): string {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return color;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((part) => (part ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const valid = isSafeStorefrontThemeColorValue(value);
  // Presets may store oklch()/rgb(); merchants see and pick hex.
  const hex = value.startsWith("#") || !valid ? value : toHex(value);
  const [left, setLeft] = useState(false);
  const server = useServerFieldError(id);
  const error = server.error ?? (!valid && (left || server.revealed) ? t("colorInvalid") : undefined);
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
            value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#000000"}
            onChange={(event) => {
              server.clear();
              onChange(event.target.value);
            }}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
        <Input
          id={id}
          value={hex}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-note` : undefined}
          onBlur={() => setLeft(true)}
          onChange={(event) => {
            server.clear();
            onChange(event.target.value);
          }}
        />
      </div>
      {error ? <p id={`${id}-note`} role="alert" className="text-body text-destructive">{error}</p> : null}
    </div>
  );
}

function ChoiceField<Value extends string>({
  id,
  label,
  value,
  values,
  labelFor,
  onChange,
}: {
  id: string;
  label: string;
  value: Value;
  values: readonly Value[];
  labelFor: (value: Value) => string;
  onChange: (value: Value) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(next) => onChange(next as Value)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((option) => (
            <SelectItem key={option} value={option}>{labelFor(option)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
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

function LogoCard({ headerDraft, footerDraft }: ReturnType<typeof useSiteDrafts>) {
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

function ThemeCards() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const { data, refetch } = useSuspenseQuery(themeQueryOptions());
  const site = useSiteDrafts();
  const { draft: theme, setDraft } = useDocumentDraft<Theme>({
    label: t("themeTitle"),
    saved: data.theme as Theme,
    fields: (path) => COLOR_FIELD_IDS[path.replace(/^theme\.colors\./, "")],
    invalid: (draft) => Object.values(draft.colors).some((value) => !isSafeStorefrontThemeColorValue(value)),
    save: async (next) => {
      try {
        const saved = await apiData(postApiV1AdminSettingsTheme({
          body: { expectedRevision: data.revision, theme: next },
        }));
        queryClient.setQueryData(themeQueryOptions().queryKey, {
          theme: saved.theme,
          revision: saved.revision,
        });
      } catch (error) {
        failSave(error, () => void refetch());
      }
    },
  });
  const option = (key: string) => t(key as MessageKey);
  const set = <K extends keyof Theme>(key: K, value: Theme[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setLayout = (update: (layout: Layout) => Partial<Layout>) =>
    setDraft((current) => ({ ...current, layout: { ...current.layout, ...update(current.layout) } }));
  const setColor = (role: keyof typeof COLOR_ROLES, value: string) =>
    setDraft((current) => {
      const colors = { ...current.colors };
      for (const token of COLOR_ROLES[role]) colors[token] = value;
      return { ...current, colors };
    });
  const { layout } = theme;
  const selectedPreset = selectedStylePreset(theme);
  const { headerDraft } = site;

  return (
    <>
      <SectionCard title={t("themeStyles")} description={t("themeStylesHelp")}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {STYLE_PRESET_THEMES.map((preset) => {
            const selected = preset.key === selectedPreset;
            return (
              <button
                key={preset.key}
                type="button"
                aria-pressed={selected}
                onClick={() => setDraft(storefrontStylePresetTheme(preset.key))}
                className={cn(
                  "rounded-xl border p-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                  selected && "border-primary outline-1 outline-primary",
                )}
              >
                <StylePreview theme={preset.theme} />
                <span className="flex items-center justify-between gap-1 px-1 pt-1.5 text-body font-medium">
                  {t(`preset_${preset.key}` as MessageKey)}
                  {selected ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                </span>
                <span className="block px-1 pb-0.5 text-body text-muted-foreground">
                  {t(`preset_${preset.key}Help` as MessageKey)}
                </span>
              </button>
            );
          })}
        </div>
      </SectionCard>

      <LogoCard {...site} />

      <SectionCard title={t("colors")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <ColorField id="theme-color-background" label={t("colorBackground")} value={colorValue(theme, "background")} onChange={(value) => setColor("background", value)} />
          <ColorField id="theme-color-text" label={t("colorText")} value={colorValue(theme, "foreground")} onChange={(value) => setColor("text", value)} />
          <ColorField id="theme-color-buttons" label={t("colorButtons")} value={colorValue(theme, "primary")} onChange={(value) => setColor("buttons", value)} />
          <ColorField id="theme-color-button-text" label={t("colorButtonText")} value={colorValue(theme, "primary-foreground")} onChange={(value) => setColor("buttonText", value)} />
        </div>
      </SectionCard>

      <SectionCard title={t("fonts")}>
        <div className="grid gap-4 sm:grid-cols-3">
          <ChoiceField id="theme-font-headings" label={t("fontHeadings")} value={theme.typography.heading} values={STOREFRONT_THEME_HEADING_FONTS} labelFor={(value) => option(`font_${value}`)} onChange={(heading) => set("typography", { ...theme.typography, heading })} />
          <ChoiceField id="theme-font-body" label={t("fontBody")} value={theme.typography.body} values={STOREFRONT_THEME_BODY_FONTS} labelFor={(value) => option(`font_${value}`)} onChange={(body) => set("typography", { ...theme.typography, body })} />
          <ChoiceField id="theme-text-size" label={t("textSize")} value={theme.typography.scale} values={STOREFRONT_THEME_TYPE_SCALES} labelFor={(value) => option(`scale_${value}`)} onChange={(scale) => set("typography", { ...theme.typography, scale })} />
        </div>
      </SectionCard>

      <SectionCard title={t("header")}>
        <VisualChoice
          label={t("layout")}
          value={layout.header}
          options={STOREFRONT_HEADER_STYLES.map((value) => ({
            value,
            label: option(`header_${value}`),
            sketch: <HeaderSketch kind={value} />,
          }))}
          onChange={(header) => setLayout(() => ({ header }))}
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
          label={t("layout")}
          value={layout.footer}
          options={STOREFRONT_FOOTER_STYLES.map((value) => ({
            value,
            label: option(`footer_${value}`),
            sketch: <FooterSketch kind={value} />,
          }))}
          onChange={(footer) => setLayout(() => ({ footer }))}
        />
      </SectionCard>

      <SectionCard
        title={t("homepageSections")}
        description={t("homepageSectionsHelp")}
        rows={<HomepageOrder order={layout.homepage} onChange={(homepage) => setLayout(() => ({ homepage }))} />}
      />

      <SectionCard title={t("productGrid")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <SegmentedChoice
            label={t("gridDesktop")}
            value={layout.grid.desktop}
            options={STOREFRONT_GRID_DESKTOP_COLUMNS.map((value) => ({ value, label: formatNumber(value) }))}
            onChange={(desktop) => setLayout((current) => ({ grid: { ...current.grid, desktop } }))}
          />
          <SegmentedChoice
            label={t("gridMobile")}
            value={layout.grid.mobile}
            options={STOREFRONT_GRID_MOBILE_COLUMNS.map((value) => ({ value, label: formatNumber(value) }))}
            onChange={(mobile) => setLayout((current) => ({ grid: { ...current.grid, mobile } }))}
          />
        </div>
      </SectionCard>

      <SectionCard title={t("productCards")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <VisualChoice
            label={t("imageRatio")}
            value={layout.productCard.imageRatio}
            options={STOREFRONT_CARD_IMAGE_RATIOS.map((value) => ({
              value,
              label: option(`ratio_${value}`),
              sketch: <CardSketch ratio={value} />,
            }))}
            onChange={(imageRatio) => setLayout((current) => ({ productCard: { ...current.productCard, imageRatio } }))}
          />
          <VisualChoice
            label={t("discountBadge")}
            value={layout.productCard.badge}
            options={STOREFRONT_CARD_BADGE_PLACEMENTS.map((value) => ({
              value,
              label: option(`badge_${value}`),
              sketch: <CardSketch ratio={layout.productCard.imageRatio} badge={value} />,
            }))}
            onChange={(badge) => setLayout((current) => ({ productCard: { ...current.productCard, badge } }))}
          />
        </div>
        <ChoiceField id="theme-cards" label={t("cardStyle")} value={theme.components.cards} values={STOREFRONT_THEME_CARD_STYLES} labelFor={(value) => option(`card_${value}`)} onChange={(cards) => set("components", { ...theme.components, cards })} />
        <SwitchField
          id="theme-card-hover-image"
          label={t("hoverImage")}
          help={t("hoverImageHelp")}
          checked={layout.productCard.hoverImage}
          onCheckedChange={(hoverImage) => setLayout((current) => ({ productCard: { ...current.productCard, hoverImage } }))}
        />
        <SwitchField
          id="theme-card-quick-buy"
          label={t("quickBuy")}
          help={t("quickBuyHelp")}
          checked={layout.productCard.quickBuy}
          onCheckedChange={(quickBuy) => setLayout((current) => ({ productCard: { ...current.productCard, quickBuy } }))}
        />
      </SectionCard>

      <SectionCard title={t("productPage")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <VisualChoice
            label={t("gallery")}
            value={layout.productPage.gallery}
            options={STOREFRONT_PRODUCT_GALLERY_LAYOUTS.map((value) => ({
              value,
              label: option(`gallery_${value}`),
              sketch: <GallerySketch layout={value} />,
            }))}
            onChange={(gallery) => setLayout((current) => ({ productPage: { ...current.productPage, gallery } }))}
          />
          <VisualChoice
            label={t("thumbnails")}
            value={layout.productPage.thumbnails}
            options={STOREFRONT_PRODUCT_THUMBNAIL_PLACEMENTS.map((value) => ({
              value,
              label: option(`thumbnails_${value}`),
              sketch: <ThumbnailSketch placement={value} />,
            }))}
            onChange={(thumbnails) => setLayout((current) => ({ productPage: { ...current.productPage, thumbnails } }))}
          />
        </div>
      </SectionCard>

      <SectionCard title={t("shape")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <ChoiceField id="theme-corners" label={t("corners")} value={theme.cornerStyle} values={STOREFRONT_THEME_CORNER_STYLES} labelFor={(value) => option(`corner_${value}`)} onChange={(value) => set("cornerStyle", value)} />
          <ChoiceField id="theme-buttons" label={t("buttonStyle")} value={theme.components.buttons} values={STOREFRONT_THEME_BUTTON_STYLES} labelFor={(value) => option(`button_${value}`)} onChange={(buttons) => set("components", { ...theme.components, buttons })} />
          <ChoiceField id="theme-inputs" label={t("inputStyle")} value={theme.components.inputs} values={STOREFRONT_THEME_INPUT_STYLES} labelFor={(value) => option(`input_${value}`)} onChange={(inputs) => set("components", { ...theme.components, inputs })} />
          <ChoiceField id="theme-spacing" label={t("spacing")} value={theme.density} values={STOREFRONT_THEME_DENSITIES} labelFor={(value) => option(`density_${value}`)} onChange={(value) => set("density", value)} />
          <ChoiceField id="theme-page-width" label={t("pageWidth")} value={theme.containerWidth} values={STOREFRONT_THEME_CONTAINER_WIDTHS} labelFor={(value) => option(`width_${value}`)} onChange={(value) => set("containerWidth", value)} />
        </div>
      </SectionCard>
    </>
  );
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
