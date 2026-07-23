import { Type } from "lucide-react";
import {
  STOREFRONT_THEME_BODY_FONTS,
  STOREFRONT_THEME_BUTTON_STYLES,
  STOREFRONT_THEME_CARD_STYLES,
  STOREFRONT_THEME_CONTAINER_WIDTHS,
  STOREFRONT_THEME_CORNER_STYLES,
  STOREFRONT_THEME_DENSITIES,
  STOREFRONT_THEME_HEADING_FONTS,
  STOREFRONT_THEME_INPUT_STYLES,
  STOREFRONT_THEME_TYPE_SCALES,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";

export function ThemeSystemWorkspace({
  theme,
  disabled,
  onChange,
}: {
  theme: StorefrontThemeSettings;
  disabled: boolean;
  onChange: (theme: StorefrontThemeSettings) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Type className="h-4 w-4 shrink-0" />
        <h2 className="text-sm font-semibold">Design system</h2>
      </div>
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
        <SelectControl
          label="Headings"
          value={theme.typography.heading}
          options={STOREFRONT_THEME_HEADING_FONTS}
          disabled={disabled}
          onChange={(heading) =>
            onChange({
              ...theme,
              typography: { ...theme.typography, heading },
            })
          }
        />
        <SelectControl
          label="Body text"
          value={theme.typography.body}
          options={STOREFRONT_THEME_BODY_FONTS}
          disabled={disabled}
          onChange={(body) =>
            onChange({
              ...theme,
              typography: { ...theme.typography, body },
            })
          }
        />
        <SelectControl
          label="Type scale"
          value={theme.typography.scale}
          options={STOREFRONT_THEME_TYPE_SCALES}
          disabled={disabled}
          onChange={(scale) =>
            onChange({
              ...theme,
              typography: { ...theme.typography, scale },
            })
          }
        />
        <SelectControl
          label="Content width"
          value={theme.containerWidth}
          options={STOREFRONT_THEME_CONTAINER_WIDTHS}
          disabled={disabled}
          onChange={(containerWidth) => onChange({ ...theme, containerWidth })}
        />
        <SelectControl
          label="Corners"
          value={theme.cornerStyle}
          options={STOREFRONT_THEME_CORNER_STYLES}
          disabled={disabled}
          onChange={(cornerStyle) => onChange({ ...theme, cornerStyle })}
        />
        <SelectControl
          label="Density"
          value={theme.density}
          options={STOREFRONT_THEME_DENSITIES}
          disabled={disabled}
          onChange={(density) => onChange({ ...theme, density })}
        />
        <SelectControl
          label="Buttons"
          value={theme.components.buttons}
          options={STOREFRONT_THEME_BUTTON_STYLES}
          disabled={disabled}
          onChange={(buttons) =>
            onChange({
              ...theme,
              components: { ...theme.components, buttons },
            })
          }
        />
        <SelectControl
          label="Fields"
          value={theme.components.inputs}
          options={STOREFRONT_THEME_INPUT_STYLES}
          disabled={disabled}
          onChange={(inputs) =>
            onChange({
              ...theme,
              components: { ...theme.components, inputs },
            })
          }
        />
        <SelectControl
          label="Product cards"
          value={theme.components.cards}
          options={STOREFRONT_THEME_CARD_STYLES}
          disabled={disabled}
          onChange={(cards) =>
            onChange({
              ...theme,
              components: { ...theme.components, cards },
            })
          }
        />
      </div>
    </section>
  );
}

function SelectControl<Value extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: Value;
  options: readonly Value[];
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <label className="flex min-h-14 min-w-0 items-center justify-between gap-3 bg-card px-3 py-2">
      <span className="min-w-0 text-xs font-medium">{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as Value)}
        className="min-h-10 min-w-0 max-w-36 rounded-md border border-input bg-background px-2.5 text-sm capitalize text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labelize(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function labelize(value: string): string {
  return value
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
