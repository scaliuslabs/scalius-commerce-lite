import { useState, type CSSProperties } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
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
  STOREFRONT_THEME_BODY_FONTS,
  STOREFRONT_THEME_BUTTON_STYLES,
  STOREFRONT_THEME_CARD_STYLES,
  STOREFRONT_THEME_COLOR_PALETTES,
  STOREFRONT_THEME_CONTAINER_WIDTHS,
  STOREFRONT_THEME_CORNER_STYLES,
  STOREFRONT_THEME_DENSITIES,
  STOREFRONT_THEME_HEADING_FONTS,
  STOREFRONT_THEME_INPUT_STYLES,
  STOREFRONT_THEME_TYPE_SCALES,
  isSafeStorefrontThemeColorValue,
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
import { SaveBarProvider, useServerFieldError } from "~/components/admin/shared/SaveBar";
import { apiData } from "~/lib/api";
import {
  footerQueryOptions,
  headerQueryOptions,
  themeQueryOptions,
} from "~/lib/api-query-options/online-store";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { ImageField } from "./ImageField";
import { OnlineStorePage, SectionCard, failSave, useDocumentDraft } from "./shared";

type Theme = StorefrontThemeSettings;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** Whole-look starting points; every value is something the storefront reads. */
const PRESETS: Array<{
  key: "classic" | "minimal" | "ocean" | "fresh" | "boutique" | "midnight";
  palette: keyof typeof STOREFRONT_THEME_COLOR_PALETTES;
  style: Omit<Theme, "colors">;
}> = [
  {
    key: "classic",
    palette: "Current",
    style: {
      typography: { heading: "system", body: "system", scale: "standard" },
      cornerStyle: "subtle", density: "comfortable", containerWidth: "wide",
      components: { buttons: "solid", inputs: "outlined", cards: "bordered" },
    },
  },
  {
    key: "minimal",
    palette: "Zinc",
    style: {
      typography: { heading: "modern", body: "modern", scale: "standard" },
      cornerStyle: "square", density: "comfortable", containerWidth: "standard",
      components: { buttons: "outline", inputs: "outlined", cards: "flat" },
    },
  },
  {
    key: "ocean",
    palette: "Ocean",
    style: {
      typography: { heading: "modern", body: "system", scale: "standard" },
      cornerStyle: "rounded", density: "comfortable", containerWidth: "wide",
      components: { buttons: "solid", inputs: "filled", cards: "elevated" },
    },
  },
  {
    key: "fresh",
    palette: "Emerald",
    style: {
      typography: { heading: "system", body: "humanist", scale: "generous" },
      cornerStyle: "rounded", density: "airy", containerWidth: "wide",
      components: { buttons: "soft", inputs: "outlined", cards: "bordered" },
    },
  },
  {
    key: "boutique",
    palette: "Rose",
    style: {
      typography: { heading: "editorial", body: "humanist", scale: "standard" },
      cornerStyle: "subtle", density: "airy", containerWidth: "focused",
      components: { buttons: "solid", inputs: "outlined", cards: "flat" },
    },
  },
  {
    key: "midnight",
    palette: "Midnight",
    style: {
      typography: { heading: "modern", body: "modern", scale: "standard" },
      cornerStyle: "subtle", density: "comfortable", containerWidth: "wide",
      components: { buttons: "solid", inputs: "filled", cards: "elevated" },
    },
  },
];

function presetTheme(preset: (typeof PRESETS)[number]): Theme {
  const colors = preset.palette === "Current"
    ? {}
    : { ...STOREFRONT_THEME_COLOR_PALETTES[preset.palette]!.colors };
  return { colors, ...structuredClone(preset.style) };
}

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

function StylePreview({ theme }: { theme: Theme }) {
  return (
    <span
      // Merchant colours are data: they reach CSS only as custom properties (DESIGN.md).
      style={{
        "--swatch-bg": colorValue(theme, "background"),
        "--swatch-fg": colorValue(theme, "foreground"),
        "--swatch-primary": colorValue(theme, "primary"),
      } as CSSProperties}
      className="flex h-16 items-end justify-between rounded-lg border bg-(--swatch-bg) p-2"
    >
      <span className="text-heading-lg text-(--swatch-fg)">Aa</span>
      <span className="h-5 w-10 rounded-md bg-(--swatch-primary)" />
    </span>
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

function ThemeCards() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const { data, refetch } = useSuspenseQuery(themeQueryOptions());
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
  const setColor = (role: keyof typeof COLOR_ROLES, value: string) =>
    setDraft((current) => {
      const colors = { ...current.colors };
      for (const token of COLOR_ROLES[role]) colors[token] = value;
      return { ...current, colors };
    });
  const sameAs = (candidate: Theme) => JSON.stringify(candidate) === JSON.stringify(theme);

  return (
    <>
      <SectionCard title={t("themeStyles")} description={t("themeStylesHelp")}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {PRESETS.map((preset) => {
            const candidate = presetTheme(preset);
            const selected = sameAs(candidate);
            return (
              <button
                key={preset.key}
                type="button"
                aria-pressed={selected}
                onClick={() => setDraft(candidate)}
                className={cn(
                  "rounded-xl border p-2 text-left hover:bg-accent",
                  selected && "outline-2 outline-offset-1 outline-ring",
                )}
              >
                <StylePreview theme={candidate} />
                <span className="mt-2 flex items-center justify-between gap-1 px-0.5 text-body font-medium">
                  {t(`preset_${preset.key}` as MessageKey)}
                  {selected ? <Check className="size-4" aria-hidden /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </SectionCard>

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

      <SectionCard title={t("layout")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <ChoiceField id="theme-corners" label={t("corners")} value={theme.cornerStyle} values={STOREFRONT_THEME_CORNER_STYLES} labelFor={(value) => option(`corner_${value}`)} onChange={(value) => set("cornerStyle", value)} />
          <ChoiceField id="theme-buttons" label={t("buttonStyle")} value={theme.components.buttons} values={STOREFRONT_THEME_BUTTON_STYLES} labelFor={(value) => option(`button_${value}`)} onChange={(buttons) => set("components", { ...theme.components, buttons })} />
          <ChoiceField id="theme-cards" label={t("cardStyle")} value={theme.components.cards} values={STOREFRONT_THEME_CARD_STYLES} labelFor={(value) => option(`card_${value}`)} onChange={(cards) => set("components", { ...theme.components, cards })} />
          <ChoiceField id="theme-inputs" label={t("inputStyle")} value={theme.components.inputs} values={STOREFRONT_THEME_INPUT_STYLES} labelFor={(value) => option(`input_${value}`)} onChange={(inputs) => set("components", { ...theme.components, inputs })} />
          <ChoiceField id="theme-spacing" label={t("spacing")} value={theme.density} values={STOREFRONT_THEME_DENSITIES} labelFor={(value) => option(`density_${value}`)} onChange={(value) => set("density", value)} />
          <ChoiceField id="theme-page-width" label={t("pageWidth")} value={theme.containerWidth} values={STOREFRONT_THEME_CONTAINER_WIDTHS} labelFor={(value) => option(`width_${value}`)} onChange={(value) => set("containerWidth", value)} />
        </div>
      </SectionCard>
    </>
  );
}

function LogoCard() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const header = useSuspenseQuery(headerQueryOptions());
  const footer = useSuspenseQuery(footerQueryOptions());
  const headerDraft = useDocumentDraft({
    label: t("headerLogo"),
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
    label: t("footerLogo"),
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

export function ThemePage() {
  const t = useMessages(onlineStoreMessages);
  return (
    <SaveBarProvider>
      <OnlineStorePage title={t("themeTitle")}>
        <ThemeCards />
        <LogoCard />
      </OnlineStorePage>
    </SaveBarProvider>
  );
}
