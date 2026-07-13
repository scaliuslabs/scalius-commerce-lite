import {
  Layers3,
  Type,
} from "lucide-react";
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
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-start gap-2 border-b px-4 py-3">
          <Type className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <h2 className="text-sm font-semibold">Design system</h2>
            <p className="text-xs text-muted-foreground">
              One bounded set of choices keeps supported storefront surfaces consistent.
            </p>
          </div>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2">
          <SelectControl
            label="Headings"
            value={theme.typography.heading}
            options={STOREFRONT_THEME_HEADING_FONTS}
            disabled={disabled}
            onChange={(heading) => onChange({
              ...theme,
              typography: { ...theme.typography, heading },
            })}
          />
          <SelectControl
            label="Body text"
            value={theme.typography.body}
            options={STOREFRONT_THEME_BODY_FONTS}
            disabled={disabled}
            onChange={(body) => onChange({
              ...theme,
              typography: { ...theme.typography, body },
            })}
          />
          <SelectControl
            label="Type scale"
            value={theme.typography.scale}
            options={STOREFRONT_THEME_TYPE_SCALES}
            disabled={disabled}
            onChange={(scale) => onChange({
              ...theme,
              typography: { ...theme.typography, scale },
            })}
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
            onChange={(buttons) => onChange({
              ...theme,
              components: { ...theme.components, buttons },
            })}
          />
          <SelectControl
            label="Fields"
            value={theme.components.inputs}
            options={STOREFRONT_THEME_INPUT_STYLES}
            disabled={disabled}
            onChange={(inputs) => onChange({
              ...theme,
              components: { ...theme.components, inputs },
            })}
          />
          <SelectControl
            label="Product cards"
            value={theme.components.cards}
            options={STOREFRONT_THEME_CARD_STYLES}
            disabled={disabled}
            onChange={(cards) => onChange({
              ...theme,
              components: { ...theme.components, cards },
            })}
          />
        </div>
      </section>

      <aside className="space-y-4 lg:sticky lg:top-20">
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Layers3 className="h-4 w-4" />
            <h2 className="text-sm font-semibold">Where it applies</h2>
          </div>
          <ol className="divide-y text-xs">
            <CoverageRow
              title="Store foundation"
              detail="Type, colors, corners, and density on supported shared components."
            />
            <CoverageRow
              title="Product listings"
              detail="Card treatment applies to collection, search, and home listing cards."
            />
            <CoverageRow
              title="Product detail"
              detail="Global type and colors apply; the owner-approved composition and content width stay protected."
            />
          </ol>
        </section>
        <section className="rounded-xl border bg-card p-3">
          <h2 className="text-sm font-semibold">Current system</h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <SummaryFact
              label="Type"
              value={`${labelize(theme.typography.heading)} / ${labelize(theme.typography.body)}`}
            />
            <SummaryFact label="Density" value={labelize(theme.density)} />
            <SummaryFact label="Corners" value={labelize(theme.cornerStyle)} />
            <SummaryFact label="Width" value={labelize(theme.containerWidth)} />
          </dl>
        </section>
      </aside>
    </div>
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

function SummaryFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium text-foreground">{value}</dd>
    </div>
  );
}

function CoverageRow({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="grid grid-cols-[0.5rem_minmax(0,1fr)] gap-2.5 px-3 py-3">
      <span className="mt-1 h-2 w-2 rounded-full bg-foreground" aria-hidden="true" />
      <span>
        <span className="block font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block leading-relaxed text-muted-foreground">
          {detail}
        </span>
      </span>
    </li>
  );
}

function labelize(value: string): string {
  return value
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
