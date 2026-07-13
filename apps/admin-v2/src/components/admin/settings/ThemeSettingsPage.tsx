import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  History,
  Loader2,
  MonitorSmartphone,
  Palette,
  RotateCcw,
  Save,
  Type,
} from "lucide-react";
import {
  DEFAULT_STOREFRONT_THEME_SETTINGS,
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

import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import {
  getThemeSettings,
  updateThemeSettings,
} from "~/lib/api-functions/settings";
import { usePermissions } from "~/contexts/PermissionContext";
import {
  getThemeColorError,
  getThemeColorPickerHex,
  getThemeColorPairStatus,
} from "./theme-color-accessibility";
import {
  DEFAULT_THEME_COLORS,
  THEME_ACTION_CONTRAST_PAIRS,
  THEME_COLOR_PALETTES,
  THEME_CONTRAST_PAIRS,
  THEME_SURFACE_CONTRAST_PAIRS,
} from "./theme-color-presets";
import {
  normalizeThemeSettingsDraft,
  rebaseThemeSettingsDraft,
  themeSettingsDraftsEqual,
} from "./theme-draft";
import { UnsavedChangesGuard } from "../shared/UnsavedChangesGuard";

const COLOR_FIELDS = [
  { key: "primary", label: "Primary", description: "Main actions and links" },
  { key: "primary-foreground", label: "On primary", description: "Text on primary actions" },
  { key: "background", label: "Page", description: "Storefront canvas" },
  { key: "foreground", label: "Page text", description: "Main storefront text" },
  { key: "secondary", label: "Secondary", description: "Secondary actions" },
  { key: "secondary-foreground", label: "On secondary", description: "Text on secondary actions" },
  { key: "card", label: "Card", description: "Product and content cards" },
  { key: "card-foreground", label: "Card text", description: "Text inside cards" },
  { key: "muted", label: "Muted", description: "Quiet surfaces" },
  { key: "muted-foreground", label: "Muted text", description: "Supporting copy" },
  { key: "accent", label: "Accent", description: "Highlighted surfaces" },
  { key: "accent-foreground", label: "On accent", description: "Text on highlights" },
  { key: "destructive", label: "Danger", description: "Errors and destructive actions" },
  { key: "destructive-foreground", label: "On danger", description: "Text on danger actions" },
  { key: "border", label: "Border", description: "Dividers and outlines" },
  { key: "input", label: "Input border", description: "Form control outlines" },
  { key: "ring", label: "Focus ring", description: "Keyboard focus indicator" },
] as const;

type ColorKey = (typeof COLOR_FIELDS)[number]["key"];

const COLOR_FIELD_BY_KEY = Object.fromEntries(
  COLOR_FIELDS.map((field) => [field.key, field]),
) as Record<ColorKey, (typeof COLOR_FIELDS)[number]>;

const COLOR_GROUPS: Array<{
  title: string;
  description: string;
  rows: ReadonlyArray<{ background: ColorKey; foreground: ColorKey }>;
}> = [
  {
    title: "Brand and actions",
    description: "The colors buyers use to recognize and act on your store.",
    rows: THEME_ACTION_CONTRAST_PAIRS,
  },
  {
    title: "Surfaces and content",
    description: "The reading surfaces behind products, pages, and supporting copy.",
    rows: THEME_SURFACE_CONTRAST_PAIRS,
  },
];

const CONTROL_KEYS: ColorKey[] = ["border", "input", "ring"];

export default function ThemeSettingsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const [theme, setTheme] = useState<StorefrontThemeSettings>(
    DEFAULT_STOREFRONT_THEME_SETTINGS,
  );
  const [savedTheme, setSavedTheme] = useState<StorefrontThemeSettings>(
    DEFAULT_STOREFRONT_THEME_SETTINGS,
  );
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState<{
    theme: StorefrontThemeSettings;
    revision: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const fetchColors = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await getThemeSettings();
      setTheme(data.theme);
      setSavedTheme(data.theme);
      setRevision(data.revision);
      setConflict(null);
      setMessage(null);
    } catch {
      setLoadError("Storefront style could not be loaded. No values have been assumed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchColors();
  }, [fetchColors]);

  const effectiveColors = useMemo(
    () => ({ ...DEFAULT_THEME_COLORS, ...theme.colors }),
    [theme.colors],
  );
  const dirty = useMemo(
    () => !themeSettingsDraftsEqual(theme, savedTheme),
    [theme, savedTheme],
  );
  const invalidKeys = useMemo(
    () =>
      COLOR_FIELDS.filter((field) => getThemeColorError(theme.colors[field.key] ?? ""))
        .map((field) => field.key),
    [theme.colors],
  );
  const contrastFailures = useMemo(
    () =>
      THEME_CONTRAST_PAIRS.filter(({ background, foreground }) =>
        (background in theme.colors || foreground in theme.colors) &&
        getThemeColorPairStatus(
          effectiveColors[foreground] ?? "",
          effectiveColors[background] ?? "",
        ).passes === false,
      ),
    [effectiveColors],
  );
  const publishBlocked = invalidKeys.length > 0 || contrastFailures.length > 0;

  const handleChange = (key: ColorKey, value: string) => {
    setTheme((previous) => ({
      ...previous,
      colors: { ...previous.colors, [key]: value },
    }));
    setMessage(null);
  };

  const updateTheme = <Key extends keyof StorefrontThemeSettings>(
    key: Key,
    value: StorefrontThemeSettings[Key],
  ) => {
    setTheme((previous) => ({ ...previous, [key]: value }));
    setMessage(null);
  };

  const applyPalette = (paletteName: string) => {
    const palette = THEME_COLOR_PALETTES[paletteName];
    if (!palette) return;
    setTheme((previous) => ({
      ...previous,
      colors:
        paletteName === "Current"
          ? {}
          : { ...previous.colors, ...palette.colors },
    }));
    setMessage(null);
  };

  const handleReset = () => {
    setTheme(DEFAULT_STOREFRONT_THEME_SETTINGS);
    setMessage(null);
  };

  const handleDiscard = () => {
    if (conflict) {
      setTheme(conflict.theme);
      setSavedTheme(conflict.theme);
      setRevision(conflict.revision);
      setConflict(null);
      setMessage(null);
      return;
    }

    setTheme(savedTheme);
    setConflict(null);
    setMessage(null);
  };

  const loadConflictingVersion = () => {
    if (!conflict) return;
    setTheme(conflict.theme);
    setSavedTheme(conflict.theme);
    setRevision(conflict.revision);
    setConflict(null);
    setMessage(null);
  };

  const rebaseLocalChanges = () => {
    if (!conflict) return;

    setTheme(
      rebaseThemeSettingsDraft({
        base: savedTheme,
        local: theme,
        latest: conflict.theme,
      }),
    );
    setSavedTheme(conflict.theme);
    setRevision(conflict.revision);
    setConflict(null);
    setMessage(null);
  };

  const handleSave = async () => {
    if (conflict) {
      setMessage({
        type: "error",
        text: "Resolve the newer published revision before publishing this draft.",
      });
      return;
    }

    if (publishBlocked) {
      setMessage({
        type: "error",
        text:
          invalidKeys.length > 0
            ? "Fix the highlighted color values before publishing."
            : "Increase the contrast of the highlighted text pairs before publishing.",
      });
      return;
    }

    try {
      setSaving(true);
      setMessage(null);
      const cleaned = normalizeThemeSettingsDraft(theme);
      const saved = await updateThemeSettings({
        data: { theme: cleaned, expectedRevision: revision },
      });
      setTheme(saved.theme);
      setSavedTheme(saved.theme);
      setRevision(saved.revision);
      setConflict(null);
      setMessage({ type: "success", text: "Storefront style published." });
    } catch (error) {
      if (isAdminApiConflictError(error)) {
        try {
          const latest = await getThemeSettings();
          setConflict(latest);
          setMessage(null);
        } catch {
          setMessage({
            type: "error",
            text: "The published theme changed elsewhere. Reload before publishing.",
          });
        }
      } else {
        setMessage({
          type: "error",
          text: "Storefront style could not be published. Your changes remain in this tab.",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4" aria-busy="true">
        <div className="h-14 animate-pulse rounded-lg bg-muted" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="h-96 animate-pulse rounded-xl bg-muted" />
          <div className="h-72 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Storefront style</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Set the visual system buyers see across the storefront.
          </p>
        </header>
        <section
          role="alert"
          className="rounded-xl border border-destructive/30 bg-card p-5"
        >
          <div className="flex max-w-xl items-start gap-3">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold">Published style is unavailable</h2>
                <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
              </div>
              <button
                type="button"
                onClick={() => void fetchColors()}
                className="min-h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-28">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Storefront style</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Set type, shape, spacing, and colors from one published system.
          </p>
        </div>
        <span className="w-fit rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground">
          Published · revision {revision || "—"}
        </span>
      </header>

      {!canManage && (
        <InlineNotice>
          Your role can review storefront style, but cannot publish changes.
        </InlineNotice>
      )}

      {conflict && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-400/50 bg-amber-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
            <div>
              <p className="font-medium">Revision {conflict.revision} was published elsewhere.</p>
              <p className="text-xs text-muted-foreground">Use the latest version, or replay only your changed fields on top of it.</p>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2">
            <button
              type="button"
              onClick={loadConflictingVersion}
              className="min-h-10 rounded-md border bg-background px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Use latest
            </button>
            <button
              type="button"
              onClick={rebaseLocalChanges}
              className="min-h-10 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Rebase mine
            </button>
          </div>
        </div>
      )}

      {message && (
        <div
          role={message.type === "error" ? "alert" : "status"}
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            message.type === "success"
              ? "border-emerald-500/30 bg-emerald-500/10"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {message.type === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {message.text}
        </div>
      )}

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-start gap-2 border-b px-4 py-3">
          <Type className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <h2 className="text-sm font-semibold">Presentation</h2>
            <p className="text-xs text-muted-foreground">
              Semantic choices stay consistent across supported storefront components.
            </p>
          </div>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
          <SelectControl
            label="Headings"
            value={theme.typography.heading}
            options={STOREFRONT_THEME_HEADING_FONTS}
            disabled={!canManage}
            onChange={(heading) => updateTheme("typography", { ...theme.typography, heading })}
          />
          <SelectControl
            label="Body text"
            value={theme.typography.body}
            options={STOREFRONT_THEME_BODY_FONTS}
            disabled={!canManage}
            onChange={(body) => updateTheme("typography", { ...theme.typography, body })}
          />
          <SelectControl
            label="Type scale"
            value={theme.typography.scale}
            options={STOREFRONT_THEME_TYPE_SCALES}
            disabled={!canManage}
            onChange={(scale) => updateTheme("typography", { ...theme.typography, scale })}
          />
          <SelectControl
            label="Content width"
            value={theme.containerWidth}
            options={STOREFRONT_THEME_CONTAINER_WIDTHS}
            disabled={!canManage}
            onChange={(containerWidth) => updateTheme("containerWidth", containerWidth)}
          />
        </div>
        <div className="grid gap-px border-t bg-border sm:grid-cols-2 xl:grid-cols-5">
          <SelectControl
            label="Corners"
            value={theme.cornerStyle}
            options={STOREFRONT_THEME_CORNER_STYLES}
            disabled={!canManage}
            onChange={(cornerStyle) => updateTheme("cornerStyle", cornerStyle)}
          />
          <SelectControl
            label="Density"
            value={theme.density}
            options={STOREFRONT_THEME_DENSITIES}
            disabled={!canManage}
            onChange={(density) => updateTheme("density", density)}
          />
          <SelectControl
            label="Buttons"
            value={theme.components.buttons}
            options={STOREFRONT_THEME_BUTTON_STYLES}
            disabled={!canManage}
            onChange={(buttons) => updateTheme("components", { ...theme.components, buttons })}
          />
          <SelectControl
            label="Fields"
            value={theme.components.inputs}
            options={STOREFRONT_THEME_INPUT_STYLES}
            disabled={!canManage}
            onChange={(inputs) => updateTheme("components", { ...theme.components, inputs })}
          />
          <SelectControl
            label="Product cards"
            value={theme.components.cards}
            options={STOREFRONT_THEME_CARD_STYLES}
            disabled={!canManage}
            onChange={(cards) => updateTheme("components", { ...theme.components, cards })}
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Starting palette</h2>
          <p className="text-xs text-muted-foreground">Apply a complete accessible palette, then adjust individual pairs.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(THEME_COLOR_PALETTES).map(([key, palette]) => (
            <button
              key={key}
              type="button"
              onClick={() => applyPalette(key)}
              disabled={!canManage}
              className="group min-h-14 rounded-lg border bg-background p-2 text-left transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="mb-2 flex overflow-hidden rounded-full border">
                {["primary", "secondary", "accent", "background"].map((colorKey) => (
                  <span
                    key={colorKey}
                    className="h-2 flex-1"
                    style={{ backgroundColor: palette.colors[colorKey] }}
                  />
                ))}
              </span>
              <span className="text-xs font-medium">{palette.label}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="space-y-4">
          {COLOR_GROUPS.map((group) => (
            <section key={group.title} className="overflow-hidden rounded-xl border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">{group.title}</h2>
                <p className="text-xs text-muted-foreground">{group.description}</p>
              </div>
              <div className="divide-y">
                {group.rows.map(({ background, foreground }) => (
                  <ColorPairRow
                    key={background}
                    background={background}
                    foreground={foreground}
                    colors={theme.colors}
                    effectiveColors={effectiveColors}
                    disabled={!canManage}
                    onChange={handleChange}
                  />
                ))}
              </div>
            </section>
          ))}

          <details className="group overflow-hidden rounded-xl border bg-card">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <span>
                <span className="block text-sm font-semibold">Advanced controls</span>
                <span className="block text-xs text-muted-foreground">Borders, inputs, and keyboard focus.</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="grid gap-0 divide-y border-t sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {CONTROL_KEYS.map((key) => (
                <ColorControl
                  key={key}
                  colorKey={key}
                  value={theme.colors[key] ?? ""}
                  effectiveValue={effectiveColors[key] ?? ""}
                  disabled={!canManage}
                  onChange={handleChange}
                />
              ))}
            </div>
          </details>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20">
          <section className="rounded-xl border bg-card p-3">
            <h2 className="text-sm font-semibold">Published scope</h2>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <SummaryFact label="Type" value={`${labelize(theme.typography.heading)} / ${labelize(theme.typography.body)}`} />
              <SummaryFact label="Density" value={labelize(theme.density)} />
              <SummaryFact label="Corners" value={labelize(theme.cornerStyle)} />
              <SummaryFact label="Width" value={labelize(theme.containerWidth)} />
            </dl>
          </section>
          <ColorPreview colors={effectiveColors} />
          <section className="rounded-xl border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Readability</h2>
              <span className={`text-xs font-medium ${publishBlocked ? "text-destructive" : "text-emerald-700 dark:text-emerald-300"}`}>
                {publishBlocked ? "Needs attention" : "Ready"}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Essential opaque hex and OKLCH text pairs must reach a 4.5:1 contrast ratio. Other functional colors remain unscored.
            </p>
          </section>
          <section className="space-y-2 rounded-xl border bg-card p-3 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <MonitorSmartphone className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Real route and device preview is not available yet. Review the live store after publishing.</p>
            </div>
            <div className="flex gap-2">
              <History className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Published revision {revision}; history and rollback are not available yet.</p>
            </div>
          </section>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/85 lg:left-[var(--sidebar-width,0px)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {dirty ? "Unpublished changes in this tab" : "Published style is up to date"}
          </p>
          <div className="grid grid-cols-3 gap-2 sm:flex">
            <button
              type="button"
              onClick={handleDiscard}
              disabled={saving || !dirty}
              className="min-h-11 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 sm:min-h-10"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={!canManage || saving}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 sm:min-h-10"
            >
              <RotateCcw className="h-4 w-4" />
              Defaults
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canManage || saving || !dirty || publishBlocked || Boolean(conflict)}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-10"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "Publishing…" : "Publish"}
            </button>
          </div>
        </div>
      </div>
      <UnsavedChangesGuard isDirty={dirty} isSubmitting={saving} />
    </div>
  );
}

function ColorPairRow({
  background,
  foreground,
  colors,
  effectiveColors,
  disabled,
  onChange,
}: {
  background: ColorKey;
  foreground: ColorKey;
  colors: Record<string, string>;
  effectiveColors: Record<string, string>;
  disabled: boolean;
  onChange: (key: ColorKey, value: string) => void;
}) {
  const status = getThemeColorPairStatus(
    effectiveColors[foreground] ?? "",
    effectiveColors[background] ?? "",
  );
  const usesOverride = background in colors || foreground in colors;

  return (
    <div className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem] sm:items-center">
      <ColorControl
        colorKey={background}
        value={colors[background] ?? ""}
        effectiveValue={effectiveColors[background] ?? ""}
        disabled={disabled}
        onChange={onChange}
      />
      <ColorControl
        colorKey={foreground}
        value={colors[foreground] ?? ""}
        effectiveValue={effectiveColors[foreground] ?? ""}
        disabled={disabled}
        onChange={onChange}
      />
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <span className="text-xs text-muted-foreground sm:hidden">Contrast</span>
        <ContrastBadge status={status} usesOverride={usesOverride} />
      </div>
    </div>
  );
}

function ColorControl({
  colorKey,
  value,
  effectiveValue,
  disabled,
  onChange,
}: {
  colorKey: ColorKey;
  value: string;
  effectiveValue: string;
  disabled: boolean;
  onChange: (key: ColorKey, value: string) => void;
}) {
  const field = COLOR_FIELD_BY_KEY[colorKey];
  const error = getThemeColorError(value);

  return (
    <label className="block min-w-0 p-0 sm:px-1">
      <span className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{field.label}</span>
        <span className="hidden truncate text-[10px] text-muted-foreground md:block">{field.description}</span>
      </span>
      <span className={`flex min-h-10 items-center gap-2 rounded-md border bg-background px-2 focus-within:ring-2 focus-within:ring-ring ${error ? "border-destructive" : "border-input"}`}>
        <input
          type="color"
          value={getThemeColorPickerHex(effectiveValue) ?? "#000000"}
          onChange={(event) => onChange(colorKey, event.target.value)}
          disabled={disabled}
          aria-label={`Pick ${field.label.toLowerCase()} color`}
          className="h-6 w-6 shrink-0 cursor-pointer appearance-none overflow-hidden rounded-full border bg-transparent p-0 disabled:cursor-not-allowed"
        />
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(colorKey, event.target.value)}
          disabled={disabled}
          placeholder={effectiveValue}
          aria-invalid={Boolean(error)}
          aria-label={`${field.label} color value`}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
        />
      </span>
      {error && <span className="mt-1 block text-xs text-destructive">{error}</span>}
    </label>
  );
}

function ContrastBadge({
  status,
  usesOverride,
}: {
  status: ReturnType<typeof getThemeColorPairStatus>;
  usesOverride: boolean;
}) {
  if (!usesOverride) {
    return <span className="rounded-full border px-2 py-1 text-[11px] text-muted-foreground">Store default</span>;
  }
  if (status.passes === null) {
    return <span className="rounded-full border px-2 py-1 text-[11px] text-muted-foreground">Unscored</span>;
  }
  return (
    <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${status.passes ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-destructive/10 text-destructive"}`}>
      {status.ratio}:1
    </span>
  );
}

function ColorPreview({ colors }: { colors: Record<string, string> }) {
  const swatches = [
    { label: "Primary action", background: "primary", foreground: "primary-foreground" },
    { label: "Secondary action", background: "secondary", foreground: "secondary-foreground" },
    { label: "Page", background: "background", foreground: "foreground" },
    { label: "Card", background: "card", foreground: "card-foreground" },
    { label: "Muted content", background: "muted", foreground: "muted-foreground" },
    { label: "Danger", background: "destructive", foreground: "destructive-foreground" },
  ];

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Palette className="h-4 w-4" />
        <h2 className="text-sm font-semibold">Semantic map</h2>
      </div>
      <div className="space-y-2 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Token-level output only. This does not imitate a storefront route.
        </p>
        {swatches.map((swatch) => (
          <div
            key={swatch.label}
            className="flex min-h-10 items-center justify-between gap-3 rounded-md border px-3 text-xs"
            style={{
              backgroundColor: colors[swatch.background],
              color: colors[swatch.foreground],
              borderColor: colors.border,
            }}
          >
            <span className="font-medium">{swatch.label}</span>
            <span className="font-mono opacity-75">Aa</span>
          </div>
        ))}
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

function SummaryFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium text-foreground">{value}</dd>
    </div>
  );
}

function labelize(value: string): string {
  return value
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function InlineNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
