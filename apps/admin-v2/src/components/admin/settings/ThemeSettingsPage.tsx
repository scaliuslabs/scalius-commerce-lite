import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Eye,
  Loader2,
  MoreHorizontal,
  Palette,
  RotateCcw,
  Save,
  Send,
} from "lucide-react";
import {
  DEFAULT_STOREFRONT_THEME_SETTINGS,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";

import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import {
  createThemePreviewSession,
  getThemeVersions,
  getThemeWorkspace,
  publishThemeDraft,
  rebaseThemeDraft,
  rollbackTheme,
  saveThemeDraft,
  type ThemeDraftPayload,
  type ThemeVersionPayload,
  type ThemeWorkspacePayload,
} from "~/lib/api-functions/settings";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";
import { usePermissions } from "~/contexts/PermissionContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
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
import {
  buildStorefrontReviewLinks,
  describeThemeDraftChanges,
  THEME_WORKSPACE_SECTIONS,
  type ThemePreviewDevice,
  type ThemeWorkspaceSection,
} from "./theme-workspace";
import { ThemeReviewWorkspace } from "./ThemeReviewWorkspace";
import { ThemeSystemWorkspace } from "./ThemeSystemWorkspace";
import {
  prepareThemePreviewWindow,
  submitThemePreview,
} from "./theme-preview-window";
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

export default function ThemeSettingsPage({
  section,
  onSectionChange,
  previewPath = "/",
  previewDevice = "desktop",
  onPreviewLocationChange = () => undefined,
}: {
  section: ThemeWorkspaceSection;
  onSectionChange: (section: ThemeWorkspaceSection) => void;
  previewPath?: string;
  previewDevice?: ThemePreviewDevice;
  onPreviewLocationChange?: (path: string, device: ThemePreviewDevice) => void;
}) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const [theme, setTheme] = useState<StorefrontThemeSettings>(
    DEFAULT_STOREFRONT_THEME_SETTINGS,
  );
  const [savedDraftTheme, setSavedDraftTheme] = useState<StorefrontThemeSettings>(
    DEFAULT_STOREFRONT_THEME_SETTINGS,
  );
  const [publishedTheme, setPublishedTheme] = useState<StorefrontThemeSettings>(
    DEFAULT_STOREFRONT_THEME_SETTINGS,
  );
  const [publishedRevision, setPublishedRevision] = useState(0);
  const [draftRevision, setDraftRevision] = useState(0);
  const [basePublishedRevision, setBasePublishedRevision] = useState(0);
  const [conflict, setConflict] = useState<ThemeWorkspacePayload | null>(null);
  const [versions, setVersions] = useState<ThemeVersionPayload[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operation, setOperation] = useState<
    "saving" | "previewing" | "publishing" | "rebasing" | `restoring:${number}` | null
  >(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const applyWorkspace = useCallback((workspace: ThemeWorkspacePayload) => {
    setTheme(workspace.draft.theme);
    setSavedDraftTheme(workspace.draft.theme);
    setPublishedTheme(workspace.published.theme);
    setPublishedRevision(workspace.published.revision);
    setDraftRevision(workspace.draft.revision);
    setBasePublishedRevision(workspace.draft.basePublishedRevision);
    setConflict(null);
  }, []);

  const fetchWorkspace = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      applyWorkspace(await getThemeWorkspace());
      setMessage(null);
    } catch {
      setLoadError("Storefront style could not be loaded. No values have been assumed.");
    } finally {
      setLoading(false);
    }
  }, [applyWorkspace]);

  useEffect(() => {
    void fetchWorkspace();
  }, [fetchWorkspace]);

  const loadHistory = useCallback(async () => {
    try {
      setHistoryLoading(true);
      setHistoryError(null);
      const result = await getThemeVersions();
      setVersions(result.versions);
    } catch {
      setHistoryError("Published history could not be loaded.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (section === "review") void loadHistory();
  }, [loadHistory, section]);

  const storefrontUrlQuery = useQuery(storefrontUrlQueryOptions());

  const effectiveColors = useMemo(
    () => ({ ...DEFAULT_THEME_COLORS, ...theme.colors }),
    [theme.colors],
  );
  const dirty = useMemo(
    () => !themeSettingsDraftsEqual(theme, savedDraftTheme),
    [theme, savedDraftTheme],
  );
  const hasUnpublishedChanges = useMemo(
    () => !themeSettingsDraftsEqual(theme, publishedTheme),
    [publishedTheme, theme],
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
    [effectiveColors, theme.colors],
  );
  const publishBlocked = invalidKeys.length > 0 || contrastFailures.length > 0;
  const configuredStorefrontUrl = storefrontUrlQuery.data?.storefrontUrl;
  const draftChanges = useMemo(
    () => describeThemeDraftChanges(publishedTheme, theme),
    [publishedTheme, theme],
  );
  const storefrontReviewLinks = useMemo(
    () => buildStorefrontReviewLinks(configuredStorefrontUrl),
    [configuredStorefrontUrl],
  );

  const handleChange = (key: ColorKey, value: string) => {
    setTheme((previous) => ({
      ...previous,
      colors: { ...previous.colors, [key]: value },
    }));
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
    setTheme(savedDraftTheme);
    setMessage(null);
  };

  const loadConflictingVersion = () => {
    if (!conflict) return;
    applyWorkspace(conflict);
    setMessage(null);
  };

  const rebaseLocalChanges = async () => {
    if (!conflict) return;
    try {
      setOperation("rebasing");
      setMessage(null);
      const rebased = rebaseThemeSettingsDraft({
        base: savedDraftTheme,
        local: theme,
        latest: conflict.draft.theme,
      });
      const saved = await rebaseThemeDraft({
        data: {
          theme: normalizeThemeSettingsDraft(rebased),
          expectedDraftRevision: conflict.draft.revision,
          basePublishedRevision: conflict.published.revision,
        },
      });
      setTheme(saved.theme);
      setSavedDraftTheme(saved.theme);
      setPublishedTheme(conflict.published.theme);
      setPublishedRevision(conflict.published.revision);
      setDraftRevision(saved.revision);
      setBasePublishedRevision(saved.basePublishedRevision);
      setConflict(null);
      setMessage({ type: "success", text: "Your changes were rebased and saved." });
    } catch (error) {
      await handleWorkspaceConflict(error, "Draft could not be rebased.");
    } finally {
      setOperation(null);
    }
  };

  const handleWorkspaceConflict = async (error: unknown, fallback: string) => {
    if (!isAdminApiConflictError(error)) {
      setMessage({ type: "error", text: fallback });
      return;
    }
    try {
      setConflict(await getThemeWorkspace());
      setMessage(null);
    } catch {
      setMessage({
        type: "error",
        text: "The storefront style changed elsewhere. Reload the workspace before continuing.",
      });
    }
  };

  const persistDraft = async (): Promise<ThemeDraftPayload | null> => {
    if (!dirty && draftRevision > 0) {
      return {
        theme: savedDraftTheme,
        revision: draftRevision,
        basePublishedRevision,
        updatedAt: null,
      };
    }
    try {
      const saved = await saveThemeDraft({
        data: {
          theme: normalizeThemeSettingsDraft(theme),
          expectedDraftRevision: draftRevision,
          basePublishedRevision,
        },
      });
      setTheme(saved.theme);
      setSavedDraftTheme(saved.theme);
      setDraftRevision(saved.revision);
      setBasePublishedRevision(saved.basePublishedRevision);
      setConflict(null);
      return saved;
    } catch (error) {
      await handleWorkspaceConflict(error, "Draft could not be saved. Your changes remain in this tab.");
      return null;
    }
  };

  const handleSaveDraft = async () => {
    if (publishBlocked) {
      setMessage({
        type: "error",
        text:
          invalidKeys.length > 0
            ? "Fix the highlighted color values before saving the draft."
            : "Increase the contrast of the highlighted text pairs before saving the draft.",
      });
      return;
    }
    try {
      setOperation("saving");
      setMessage(null);
      const saved = await persistDraft();
      if (saved) setMessage({ type: "success", text: `Draft revision ${saved.revision} saved.` });
    } finally {
      setOperation(null);
    }
  };

  const handlePreview = async (
    selectedPath = previewPath,
    selectedDevice = previewDevice,
  ) => {
    if (!configuredStorefrontUrl) {
      setMessage({ type: "error", text: "Configure a valid Storefront URL before previewing." });
      return;
    }
    if (publishBlocked) {
      setMessage({ type: "error", text: "Resolve the highlighted style issues before previewing." });
      return;
    }
    const previewWindow = prepareThemePreviewWindow({
      storefrontUrl: configuredStorefrontUrl,
      path: selectedPath,
      device: selectedDevice,
    });
    if (!previewWindow) {
      setMessage({ type: "error", text: "Allow pop-ups for this dashboard to open the preview." });
      return;
    }
    try {
      setOperation("previewing");
      setMessage(null);
      const saved = await persistDraft();
      if (!saved) {
        previewWindow.close();
        return;
      }
      const preview = await createThemePreviewSession({
        data: { expectedDraftRevision: saved.revision },
      });
      await submitThemePreview({
        previewWindow,
        storefrontUrl: configuredStorefrontUrl,
        token: preview.token,
      });
      setMessage({ type: "success", text: `Preview opened from draft revision ${saved.revision}.` });
    } catch (error) {
      previewWindow.close();
      await handleWorkspaceConflict(error, "Draft preview could not be opened.");
    } finally {
      setOperation(null);
    }
  };

  const handlePublish = async () => {
    if (conflict) {
      setMessage({
        type: "error",
        text: "Resolve the newer saved draft before publishing.",
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
      setOperation("publishing");
      setMessage(null);
      const saved = await persistDraft();
      if (!saved) return;
      if (themeSettingsDraftsEqual(saved.theme, publishedTheme)) {
        setMessage({ type: "success", text: "Published style is already current." });
        return;
      }
      const workspace = await publishThemeDraft({
        data: {
          expectedPublishedRevision: publishedRevision,
          expectedDraftRevision: saved.revision,
        },
      });
      applyWorkspace(workspace);
      setMessage({ type: "success", text: `Storefront style published as revision ${workspace.published.revision}.` });
      if (section === "review") void loadHistory();
    } catch (error) {
      await handleWorkspaceConflict(error, "Storefront style could not be published. The saved draft remains available.");
    } finally {
      setOperation(null);
    }
  };

  const handleRestore = async (sourceRevision: number) => {
    try {
      setOperation(`restoring:${sourceRevision}`);
      setMessage(null);
      let exactDraftRevision = draftRevision;
      if (exactDraftRevision === 0) {
        const saved = await saveThemeDraft({
          data: {
            theme: savedDraftTheme,
            expectedDraftRevision: 0,
            basePublishedRevision,
          },
        });
        exactDraftRevision = saved.revision;
      }
      const workspace = await rollbackTheme({
        data: {
          sourceRevision,
          expectedPublishedRevision: publishedRevision,
          expectedDraftRevision: exactDraftRevision,
        },
      });
      applyWorkspace(workspace);
      setMessage({
        type: "success",
        text: `Revision ${sourceRevision} restored as published revision ${workspace.published.revision}.`,
      });
      await loadHistory();
    } catch (error) {
      await handleWorkspaceConflict(error, `Revision ${sourceRevision} could not be restored.`);
    } finally {
      setOperation(null);
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
              onClick={() => void fetchWorkspace()}
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
        <div className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-full border bg-card px-2.5 py-1">
            Published r{publishedRevision || "—"}
          </span>
          <span className="rounded-full border bg-card px-2.5 py-1">
            Draft {draftRevision > 0 ? `r${draftRevision}` : "new"}
            {dirty ? " · unsaved" : " · saved"}
          </span>
        </div>
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
              <p className="font-medium">The saved draft or published style changed elsewhere.</p>
              <p className="text-xs text-muted-foreground">
                Load draft r{conflict.draft.revision}, or replay only your changed fields on top of it.
              </p>
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
              onClick={() => void rebaseLocalChanges()}
              disabled={operation === "rebasing"}
              className="min-h-10 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {operation === "rebasing" ? "Rebasing…" : "Rebase mine"}
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

      <nav
        aria-label="Theme settings"
        className="flex gap-1 overflow-x-auto rounded-lg border bg-card p-1"
      >
        {THEME_WORKSPACE_SECTIONS.map((workspace) => {
          const active = workspace.value === section;
          return (
            <button
              key={workspace.value}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSectionChange(workspace.value)}
              className={`min-h-10 shrink-0 rounded-md px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                active
                  ? "bg-foreground font-medium text-background shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {workspace.label}
            </button>
          );
        })}
      </nav>

      {section === "system" && (
        <ThemeSystemWorkspace
          theme={theme}
          disabled={!canManage}
          onChange={(nextTheme) => {
            setTheme(nextTheme);
            setMessage(null);
          }}
        />
      )}

      {section === "colors" && (
        <div className="space-y-4">
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
            </aside>
          </div>
        </div>
      )}

      {section === "review" && (
        <ThemeReviewWorkspace
          draftChanges={draftChanges}
          publishedRevision={publishedRevision}
          draftRevision={draftRevision}
          dirty={dirty}
          hasUnpublishedChanges={hasUnpublishedChanges}
          publishBlocked={publishBlocked}
          storefrontLinks={storefrontReviewLinks}
          storefrontUrlUnavailable={storefrontUrlQuery.isError}
          previewPath={previewPath}
          previewDevice={previewDevice}
          onPreviewLocationChange={onPreviewLocationChange}
          onPreview={(path, device) => void handlePreview(path, device)}
          previewing={operation === "previewing"}
          versions={versions}
          historyLoading={historyLoading}
          historyError={historyError}
          canManage={canManage}
          restoringRevision={operation?.startsWith("restoring:") ? Number(operation.split(":")[1]) : null}
          onRestore={(sourceRevision) => void handleRestore(sourceRevision)}
        />
      )}

      <div
        data-testid="theme-action-bar"
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/85 lg:left-[var(--sidebar-width,0px)] sm:py-3 sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="truncate text-xs text-muted-foreground">
            {dirty
              ? "Unsaved in this tab"
              : hasUnpublishedChanges
                ? `Draft r${draftRevision || "new"} saved · not published`
                : "Published style is current"}
          </p>
          <div
            data-testid="theme-primary-actions"
            className="grid grid-cols-[2.75rem_repeat(3,minmax(0,1fr))] gap-2 sm:flex"
          >
            <div className="sm:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="More theme actions"
                    title="More theme actions"
                    disabled={operation !== null}
                    className="inline-flex min-h-11 w-full items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-52">
                  <DropdownMenuItem onSelect={handleDiscard} disabled={!dirty}>
                    Discard tab changes
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleReset} disabled={!canManage}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Restore store defaults
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <button
              type="button"
              onClick={handleDiscard}
              disabled={operation !== null || !dirty}
              className="hidden min-h-10 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 sm:inline-flex sm:items-center sm:justify-center"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={!canManage || operation !== null}
              className="hidden min-h-10 items-center justify-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 sm:inline-flex"
            >
              <RotateCcw className="h-4 w-4" />
              Defaults
            </button>
            <button
              type="button"
              onClick={() => void handleSaveDraft()}
              aria-label={operation === "saving" ? "Saving theme draft" : "Save draft"}
              disabled={!canManage || operation !== null || !dirty || publishBlocked || Boolean(conflict)}
              className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md border bg-background px-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-10 sm:px-3"
            >
              {operation === "saving" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              <span className="truncate">{operation === "saving" ? "Saving…" : "Save"}</span>
              <span className="sr-only"> draft</span>
            </button>
            <button
              type="button"
              onClick={() => void handlePreview()}
              disabled={operation !== null || publishBlocked || Boolean(conflict) || !configuredStorefrontUrl || (!canManage && draftRevision === 0)}
              className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md border bg-background px-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-10 sm:px-3"
            >
              {operation === "previewing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
              {operation === "previewing" ? "Opening…" : "Preview"}
            </button>
            <button
              type="button"
              onClick={() => void handlePublish()}
              disabled={!canManage || operation !== null || !hasUnpublishedChanges || publishBlocked || Boolean(conflict)}
              className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-10 sm:px-4"
            >
              {operation === "publishing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {operation === "publishing" ? "Publishing…" : "Publish"}
            </button>
          </div>
        </div>
      </div>
      <UnsavedChangesGuard isDirty={dirty} isSubmitting={operation !== null} />
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

function InlineNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
