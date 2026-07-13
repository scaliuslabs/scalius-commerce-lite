import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Loader2,
  Palette,
  RotateCcw,
  Save,
} from "lucide-react";

import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import {
  getThemeSettings,
  updateThemeSettings,
} from "~/lib/api-functions/settings";
import { usePermissions } from "~/contexts/PermissionContext";
import {
  getThemeColorError,
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
  normalizeThemeColors,
  rebaseThemeColorDraft,
  themeColorRecordsEqual,
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
const isPickerHex = (value: string) => /^#[\da-f]{6}$/i.test(value);

export default function ThemeSettingsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [savedColors, setSavedColors] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState<{
    colors: Record<string, string>;
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
      setColors(data.colors);
      setSavedColors(data.colors);
      setRevision(data.revision);
      setConflict(null);
      setMessage(null);
    } catch {
      setLoadError("Theme colors could not be loaded. No values have been assumed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchColors();
  }, [fetchColors]);

  const effectiveColors = useMemo(
    () => ({ ...DEFAULT_THEME_COLORS, ...colors }),
    [colors],
  );
  const dirty = useMemo(
    () => !themeColorRecordsEqual(colors, savedColors),
    [colors, savedColors],
  );
  const invalidKeys = useMemo(
    () =>
      COLOR_FIELDS.filter((field) => getThemeColorError(colors[field.key] ?? ""))
        .map((field) => field.key),
    [colors],
  );
  const contrastFailures = useMemo(
    () =>
      THEME_CONTRAST_PAIRS.filter(({ background, foreground }) =>
        getThemeColorPairStatus(
          effectiveColors[foreground] ?? "",
          effectiveColors[background] ?? "",
        ).passes === false,
      ),
    [effectiveColors],
  );
  const publishBlocked = invalidKeys.length > 0 || contrastFailures.length > 0;

  const handleChange = (key: ColorKey, value: string) => {
    setColors((previous) => ({ ...previous, [key]: value }));
    setMessage(null);
  };

  const applyPalette = (paletteName: string) => {
    const palette = THEME_COLOR_PALETTES[paletteName];
    if (!palette) return;
    setColors((previous) => ({ ...previous, ...palette.colors }));
    setMessage(null);
  };

  const handleReset = () => {
    setColors({});
    setMessage(null);
  };

  const handleDiscard = () => {
    if (conflict) {
      setColors(conflict.colors);
      setSavedColors(conflict.colors);
      setRevision(conflict.revision);
      setConflict(null);
      setMessage(null);
      return;
    }

    setColors(savedColors);
    setConflict(null);
    setMessage(null);
  };

  const loadConflictingVersion = () => {
    if (!conflict) return;
    setColors(conflict.colors);
    setSavedColors(conflict.colors);
    setRevision(conflict.revision);
    setConflict(null);
    setMessage(null);
  };

  const rebaseLocalChanges = () => {
    if (!conflict) return;

    setColors(
      rebaseThemeColorDraft({
        base: savedColors,
        local: colors,
        latest: conflict.colors,
      }),
    );
    setSavedColors(conflict.colors);
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
      const cleaned = normalizeThemeColors(colors);
      const saved = await updateThemeSettings({
        data: { colors: cleaned, expectedRevision: revision },
      });
      setColors(saved.colors);
      setSavedColors(saved.colors);
      setRevision(saved.revision);
      setConflict(null);
      setMessage({ type: "success", text: "Theme colors published." });
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
          text: "Theme colors could not be published. Your changes remain in this tab.",
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
          <h1 className="text-xl font-semibold tracking-tight">Theme colors</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Set the colors buyers see across storefront pages and checkout.
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
                <h2 className="text-sm font-semibold">Published colors are unavailable</h2>
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
          <h1 className="text-xl font-semibold tracking-tight">Theme colors</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Set the colors buyers see across storefront pages and checkout.
          </p>
        </div>
        <span className="w-fit rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground">
          Published · revision {revision || "—"}
        </span>
      </header>

      {!canManage && (
        <InlineNotice>
          Your role can review theme colors, but cannot publish changes.
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
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Starting palette</h2>
          <p className="text-xs text-muted-foreground">Apply a complete accessible palette, then adjust individual pairs.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-5">
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
                    colors={colors}
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
                  value={colors[key] ?? ""}
                  effectiveValue={effectiveColors[key] ?? ""}
                  disabled={!canManage}
                  onChange={handleChange}
                />
              ))}
            </div>
          </details>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20">
          <ColorPreview colors={effectiveColors} />
          <section className="rounded-xl border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Readability</h2>
              <span className={`text-xs font-medium ${publishBlocked ? "text-destructive" : "text-emerald-700 dark:text-emerald-300"}`}>
                {publishBlocked ? "Needs attention" : "Ready"}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Essential hex color pairs must reach a 4.5:1 contrast ratio. Functional CSS colors are validated but cannot be scored here.
            </p>
          </section>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/85 lg:left-[var(--sidebar-width,0px)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {dirty ? "Unpublished changes in this tab" : "Published colors are up to date"}
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
        <ContrastBadge status={status} />
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
          value={isPickerHex(effectiveValue) ? effectiveValue : "#000000"}
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
}: {
  status: ReturnType<typeof getThemeColorPairStatus>;
}) {
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
          A token-level check only. Storefront layout and device previews belong in the versioned presentation editor.
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

function InlineNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
