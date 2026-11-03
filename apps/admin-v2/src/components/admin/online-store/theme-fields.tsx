/**
 * Theme setting controls the Theme page and the theme editor share: the
 * colour scheme and colour fields, fit notes (why a choice shows something
 * else on this store) and a block variant's generated settings.
 */
import type { SettingBindings } from "@scalius/shared/storefront-theme/bindings";
import { SettingBindingScope } from "./schema-form/binding-context";
import { useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  STOREFRONT_COLOR_SCHEMES,
  STOREFRONT_THEME_MIN_CONTRAST,
  isStorefrontThemeHexColor,
  storefrontBlockValue,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontColorScheme,
  type StorefrontThemeColorSet,
  type StorefrontThemeDocument,
  type StorefrontThemeFallback,
} from "@scalius/shared/storefront-theme";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useServerFieldError } from "~/components/admin/shared/SaveBar";
import { formatNumber, useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeSettingMessages } from "~/i18n/theme-settings";
import { settingErrors } from "./schema-form/errors";
import { blockLabelScope } from "./schema-form/labels";
import { blockSettingSpec, hasSettings } from "./schema-form/registry-forms";
import type { MediaPreviews } from "./schema-form/resource-fields";
import { SchemaSettingsForm } from "./schema-form/SchemaSettingsForm";
import {
  COLOR_ROLE_TOKEN,
  colorFieldId,
  darkColorsEdited,
  regenerateDarkColors,
  themeColorSetProblem,
  setColorScheme,
  setColorSchemeToggle,
  setThemeColor,
  themeColorSets,
  themeContrastProblems,
  type ColorRole,
  type ContrastProblem,
  type ThemeBlockSlot,
} from "./theme-settings";
import { PreviewColorSetContext, useThemeReveal } from "./theme-reveal";
import { ChoiceField, Field } from "~/components/ui/field";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";

export { useFitReason } from "./use-fit-reason";

export type Theme = StorefrontThemeDocument;
export type SetTheme = (next: Theme | ((theme: Theme) => Theme)) => void;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** What a block variant renders today, for its picker sketch. */
export function variantRenders<Render>(slot: ThemeBlockSlot, variant: string): Render {
  const spec = storefrontVariantSpec(slot, variant);
  return (spec.renders as (settings: unknown) => Render)(spec.defaults);
}

/** Ratios round down, so "4.4:1" never reads as the 4.5:1 it misses. */
const formatRatio = (ratio: number) =>
  formatNumber(Math.floor(ratio * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function ColorField({
  id,
  label,
  value,
  problems,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  /** Text this colour leaves below AA, in plain words. */
  problems: readonly ContrastProblem[];
  onChange: (value: string) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const valid = isStorefrontThemeHexColor(value);
  const [left, setLeft] = useState(false);
  const server = useServerFieldError(id);
  const asked = useThemeReveal() !== null;
  const errors = [
    server.error ?? (!valid && (left || server.revealed || asked) ? t("colorInvalid") : undefined),
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
    <Field id={id} label={label}>
      <div className="flex items-center gap-2">
        <label
          style={{ "--swatch": valid ? value : "transparent" } as CSSProperties}
          className="relative size-11 shrink-0 cursor-pointer rounded-lg border bg-(--swatch) sm:pointer-fine:size-9"
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
    </Field>
  );
}

const COLOR_FIELDS: ReadonlyArray<{ role: ColorRole; label: MessageKey }> = [
  { role: "background", label: "colorBackground" },
  { role: "text", label: "colorText" },
  { role: "buttons", label: "colorButtons" },
  { role: "buttonText", label: "colorButtonText" },
  { role: "highlight", label: "colorHighlight" },
  { role: "highlightText", label: "colorHighlightText" },
];

/** The six colours of one set, each with the readable-text problems it causes. */
function ColorSetFields({ theme, set, setDraft }: { theme: Theme; set: StorefrontThemeColorSet; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const colors = theme.tokens[set];
  if (!colors) return null;
  const problems = themeContrastProblems(theme, set);
  return (
    <div className="grid gap-4 @lg:grid-cols-2">
      {COLOR_FIELDS.map(({ role, label }) => (
        <ColorField
          key={role}
          id={colorFieldId(role, set)}
          label={t(label)}
          value={colors[COLOR_ROLE_TOKEN[role]]}
          problems={problems.filter((problem) => problem.role === role)}
          onChange={(value) => setDraft((current) => setThemeColor(current, role, value, set))}
        />
      ))}
    </div>
  );
}

/**
 * The colour scheme (light, dark or the shopper's device), the shoppers'
 * switch, and the colours: one set, or the colours and the dark colours on
 * two tabs once the store shows dark pages. Turning dark on stores dark
 * colours made from the colours, so a newcomer gets a finished look.
 */
export function ColorFields({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const preview = useContext(PreviewColorSetContext);
  const [ownSet, setOwnSet] = useState<StorefrontThemeColorSet>("colors");
  const sets = themeColorSets(theme);
  const shown = sets.includes(preview?.set ?? ownSet) ? preview?.set ?? ownSet : "colors";
  const show = (set: StorefrontThemeColorSet) => (preview ? preview.setSet(set) : setOwnSet(set));
  // "Setting to fix" opens the tab of the colour set its field is in.
  const reveal = useThemeReveal();
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    if (reveal?.group === "colors" && reveal.colorSet) showRef.current(reveal.colorSet);
  }, [reveal]);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const regenerate = () => {
    setConfirmRegenerate(false);
    setDraft((current) => regenerateDarkColors(current));
  };
  const darkProblem = themeColorSetProblem(theme, "darkColors") !== null;
  const scheme = (value: StorefrontColorScheme) => {
    setDraft((current) => setColorScheme(current, value));
    // The canvas follows the choice: dark shows the dark colours, light the colours.
    if (value !== "system") show(value === "dark" ? "darkColors" : "colors");
  };
  return (
    <div className="space-y-4">
      <Field id="theme-color-scheme" label={t("colorScheme")}>
        <SearchableSelect
          id="theme-color-scheme"
          value={theme.tokens.colorScheme}
          options={STOREFRONT_COLOR_SCHEMES.map((value) => ({
            value,
            label: t(`colorScheme_${value}` as MessageKey),
            description: t(`colorScheme_${value}Help` as MessageKey),
          }))}
          onValueChange={(value) => scheme(value as StorefrontColorScheme)}
          triggerClassName="w-full"
        />
      </Field>
      <ChoiceField
        id="theme-color-scheme-toggle"
        label={t("colorSchemeToggle")}
        help={t("colorSchemeToggleHelp")}
        control={(
          <Switch
            id="theme-color-scheme-toggle"
            checked={theme.tokens.colorSchemeToggle}
            aria-describedby="theme-color-scheme-toggle-help"
            onCheckedChange={(checked) => setDraft((current) => setColorSchemeToggle(current, checked))}
          />
        )}
      />
      {sets.length > 1 ? (
        <Tabs value={shown} onValueChange={(value) => show(value as StorefrontThemeColorSet)}>
          <TabsList aria-label={t("colorSets")}>
            <TabsTrigger value="colors">{t("colorSet_colors")}</TabsTrigger>
            <TabsTrigger value="darkColors">
              {t("colorSet_darkColors")}
              {darkProblem ? (
                <>
                  <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
                  <span className="sr-only">{t("colorSetNeedsFix")}</span>
                </>
              ) : null}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="colors">
            <ColorSetFields theme={theme} set="colors" setDraft={setDraft} />
          </TabsContent>
          <TabsContent value="darkColors" className="space-y-4">
            <p className="text-body text-muted-foreground">{t("darkColorsHelp")}</p>
            <ColorSetFields theme={theme} set="darkColors" setDraft={setDraft} />
            <Button
              type="button"
              variant="outline"
              disabled={!darkColorsEdited(theme)}
              onClick={() => setConfirmRegenerate(true)}
            >
              {t("darkColorsRegenerate")}
            </Button>
            <ConfirmDialog
              open={confirmRegenerate}
              onOpenChange={setConfirmRegenerate}
              title={t("darkColorsRegenerateTitle")}
              description={t("darkColorsRegenerateDescription")}
              confirmLabel={t("darkColorsRegenerate")}
              onConfirm={regenerate}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <ColorSetFields theme={theme} set="colors" setDraft={setDraft} />
      )}
    </div>
  );
}

/** Under a picker: the choice does not fit this store, what shows instead and why. */
export function FitNote({ fallback, name, reason }: {
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

/** The document with a block's settings replaced, wherever the block sits. */
function withBlockSettings(theme: Theme, slot: StorefrontBlockSlot, settings: Record<string, unknown>, changes?: { bindings?: SettingBindings }): Theme {
  const block = { ...storefrontBlockValue(theme.blocks, slot), settings, ...changes } as never;
  if (slot === "listing") return { ...theme, blocks: { ...theme.blocks, listing: { ...theme.blocks.listing, layout: block } } };
  if (slot === "gallery" || slot === "buyBox") {
    return { ...theme, blocks: { ...theme.blocks, product: { ...theme.blocks.product, [slot]: block } } };
  }
  return { ...theme, blocks: { ...theme.blocks, [slot]: block } };
}

/** The document path of a block's settings, for its field ids. */
const blockPath = (slot: StorefrontBlockSlot) =>
  slot === "listing" ? "blocks.listing.layout.settings" : slot === "gallery" || slot === "buyBox" ? `blocks.product.${slot}.settings` : `blocks.${slot}.settings`;

/** The field id prefix of a block's settings (`theme-blocks-topBar-settings`). */
export const blockFieldPrefix = (slot: StorefrontBlockSlot) => `theme-${blockPath(slot).replace(/\./g, "-")}`;

/** The chosen variant's own settings, generated from its registry schema; nothing when it has none. */
export function BlockSettingsFields({ slot, theme, setDraft, media }: {
  slot: StorefrontBlockSlot;
  theme: Theme;
  setDraft: SetTheme;
  media: MediaPreviews;
}) {
  const t = useMessages(themeSettingMessages);
  const block = storefrontBlockValue(theme.blocks, slot);
  const spec = blockSettingSpec(slot, block.variant);
  if (!hasSettings(spec)) return null;
  const errors = new Map([...settingErrors(storefrontVariantSpec(slot, block.variant).settings, block.settings)]
    .map(([path, error]) => [path, t(error.key, error.values)]));
  return (
    <SettingBindingScope bindings={block.bindings} onChange={(bindings) => setDraft((current) => withBlockSettings(current, slot, storefrontBlockValue(current.blocks, slot).settings, { bindings }))}>
    <SchemaSettingsForm
      key={block.variant}
      idPrefix={blockFieldPrefix(slot)}
      scope={blockLabelScope(slot, block.variant)}
      spec={spec}
      value={block.settings}
      errors={errors}
      media={media}
      onChange={(settings) => setDraft((current) =>
        storefrontBlockValue(current.blocks, slot).variant === block.variant ? withBlockSettings(current, slot, settings) : current)}
    />
    </SettingBindingScope>
  );
}
