/**
 * Theme setting controls the Theme page and the theme editor share: the
 * colour fields, fit notes (why a choice shows something else on this
 * store) and a block variant's generated settings.
 */
import { useState, type CSSProperties } from "react";
import {
  STOREFRONT_THEME_MIN_CONTRAST,
  isStorefrontThemeHexColor,
  storefrontBlockValue,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontThemeDocument,
  type StorefrontThemeFallback,
} from "@scalius/shared/storefront-theme";
import { Input } from "~/components/ui/input";
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
  COLOR_FIELD_IDS,
  COLOR_ROLE_TOKEN,
  setThemeColor,
  themeContrastProblems,
  type ColorRole,
  type ContrastProblem,
  type ThemeBlockSlot,
} from "./theme-settings";
import { useThemeReveal } from "./theme-reveal";
import { Field } from "~/components/ui/field";

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

/** The six colours a merchant picks, each with the readable-text problems it causes. */
export function ColorFields({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const problems = themeContrastProblems(theme);
  return (
    <div className="grid gap-4 @lg:grid-cols-2">
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
function withBlockSettings(theme: Theme, slot: StorefrontBlockSlot, settings: Record<string, unknown>): Theme {
  const block = { ...storefrontBlockValue(theme.blocks, slot), settings } as never;
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
  );
}
