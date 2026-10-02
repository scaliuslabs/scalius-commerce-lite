/**
 * The theme editor (Online store → Theme → Customize), Shopify's shape: a
 * sidebar with page sections and fixed template blocks, the store's own and its active apps'
 * (drag to reorder, add, duplicate, remove with undo), or the selected
 * section's generated settings (an app section's from its app's fields), and the
 * theme settings; the real storefront in the middle, rendering the draft;
 * a top bar with the preview width, undo and redo, Save, Preview and
 * Publish. Edits save to the shared draft by themselves (debounced, against
 * the draft revision they started from); a settings change re-renders only
 * its section in the preview, any other change reloads the page.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Laptop, Monitor, Redo2, Smartphone, Undo2 } from "lucide-react";
import { toast } from "sonner";
import {
  postApiV1AdminSettingsThemeDraft,
  postApiV1AdminSettingsThemeRestore,
  postApiV1AdminSettingsThemeDiscard,
  postApiV1AdminSettingsThemePublish,
} from "@scalius/api-client/sdk";
import { PLUGIN_HOME_SECTIONS_MAX } from "@scalius/shared/plugins/storefront";
import {
  STOREFRONT_MAX_SECTIONS,
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_RENDERERS,
  failedFitConditions,
  isStorefrontAppSection,
  storefrontSectionNeedsContent,
  storefrontSectionRenderer,
  storefrontThemeDocumentSchema,
  type StoreShape,
  type StorefrontAppSection,
  type StorefrontPlatformSection,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "~/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { matchesShortcut, typingIn } from "~/components/admin/layout/shortcuts";
import { apiData } from "~/lib/api";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import { themeWorkspaceQueryOptions, type ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { formatDateTime, useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { SectionSettingsForm, useSectionErrors } from "../SectionSettings";
import { appSettingDefaults, appValuesInvalid } from "../schema-form/app-settings";
import { useMediaPreviews } from "../schema-form/resource-fields";
import { actionErrorText } from "../shared";
import { useFitReason, type SetTheme } from "../theme-fields";
import { resolveThemeForStore, themeDraftInvalid } from "../theme-settings";
import { useOpenThemePreview } from "../ThemePreviewAction";
import { AppSectionSettings } from "./AppSectionSettings";
import {
  addAppSection,
  addSection,
  appSectionsByKey,
  appSectionsInvalid,
  canAddSectionType,
  duplicateSection,
  editorHistory,
  moveSectionTo,
  previewChange,
  removeSection,
  restoreSection,
  setAppSectionValues,
  startHistory,
  type AppSectionEntry,
} from "./editor-state";
import { PreviewFrame, type PreviewController, type PreviewDevice } from "./PreviewFrame";
import { SectionList, type SectionRowInfo } from "./SectionList";
import { SectionPicker } from "./SectionPicker";
import { PageSelector, LandingSettings, TemplateBlocks, type EditorPage, type FixedEditorPage } from "./PageTemplates";
import { ThemeHistory, themeVersionsKey } from "./ThemeHistory";
import { SettingsGroup, ThemeSettingsPanel } from "./ThemeSettingsPanel";

type Theme = StorefrontThemeDocument;
type Section = StorefrontSection;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** How long the editor waits after the last edit before saving the draft. */
export const AUTOSAVE_DELAY_MS = 800;

const same = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);
const validTemplatePath = (page: FixedEditorPage, path: string) => (page === "product" ? /^\/products\/[A-Za-z0-9_-]+$/ : /^\/(collections|categories)\/[A-Za-z0-9_-]+$/).test(path);

interface SavedDraft {
  theme: Theme;
  revision: number;
  basePublishedRevision: number;
}

/** Field issues a rejected save reported, by section id (paths under its settings). */
type SectionIssues = ReadonlyMap<string, ReadonlyMap<string, string>>;

function sectionIssues(error: unknown, theme: Theme): { sections: SectionIssues; other: string | null } {
  const issues = readApiFieldIssues(error) ?? [];
  const sections = new Map<string, Map<string, string>>();
  let other: string | null = null;
  for (const issue of issues) {
    const match = /^(?:theme\.)?pages\.(home|landing\.([^.]+)\.sections)\.(\d+)\.settings\.?(.*)$/.exec(issue.path);
    const list = match?.[2] ? theme.pages.landing[match[2]]?.sections : theme.pages.home;
    const id = match ? list?.[Number(match[3])]?.id : undefined;
    if (id) {
      const map = sections.get(id) ?? new Map<string, string>();
      map.set(match![4] ?? "", issue.message);
      sections.set(id, map);
    } else {
      other ??= issue.message;
    }
  }
  // The status line says the first problem; the fields say each one.
  return { sections, other: other ?? issues[0]?.message ?? actionErrorText(error) };
}

const DEVICES: ReadonlyArray<{ value: PreviewDevice; icon: typeof Monitor }> = [
  { value: "desktop", icon: Monitor },
  { value: "tablet", icon: Laptop },
  { value: "phone", icon: Smartphone },
];

/** Add-section menu values naming an app's section: `app:<plugin id>/<type>`. */
const APP_OPTION = "app:";

/** An app section's name: its app's name for it, or its key while the app is not active. */
function appSectionName(section: StorefrontAppSection, apps: ReadonlyMap<string, AppSectionEntry>): string {
  return apps.get(section.settings.app)?.section.name ?? section.settings.app;
}

function useSectionName(apps: ReadonlyMap<string, AppSectionEntry>) {
  const t = useMessages(onlineStoreMessages);
  // The merchant's own heading names a section; its type otherwise.
  return (section: Section) => {
    if (isStorefrontAppSection(section)) return appSectionName(section, apps);
    const settings = section.settings as { title?: unknown; heading?: unknown };
    const own = [settings.title, settings.heading].find((value): value is string => typeof value === "string" && value.trim() !== "");
    return own?.trim() || t(`section_${section.type}` as MessageKey);
  };
}

/** The selected section: its kind as the title, a note on why buyers may not see it, then its settings. */
function SectionPanel({ title, note, onBack, children }: {
  title: string;
  note?: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const t = useMessages(themeEditorMessages);
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-card px-2 py-2">
        <Button type="button" variant="ghost" size="icon" aria-label={t("allSections")} onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-heading-sm">{title}</h2>
      </div>
      <div className="space-y-4 px-4 py-4">
        {note ? <p role="status" className="text-body text-muted-foreground">{note}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** A platform section's generated settings, with its errors (the form's own and a rejected save's). */
function PlatformSectionSettings({ section, issues, media, onChange }: {
  section: StorefrontPlatformSection;
  issues?: ReadonlyMap<string, string>;
  media: ReturnType<typeof useMediaPreviews>;
  onChange: (settings: StorefrontPlatformSection["settings"]) => void;
}) {
  const own = useSectionErrors(section);
  const errors = useMemo(() => new Map([...own, ...(issues ?? [])]), [own, issues]);
  return <SectionSettingsForm section={section} media={media} errors={errors} onChange={onChange} />;
}

export function ThemeEditor({ workspace, refetch }: {
  workspace: ThemeWorkspaceDocument;
  refetch: () => Promise<{ data?: ThemeWorkspaceDocument }>;
}) {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const storeShape = workspace.storeShape as StoreShape;
  const media = useMediaPreviews(workspace.media);
  const [history, dispatchHistory] = useReducer(editorHistory, workspace.draft.theme as Theme, startHistory);
  const theme = history.present;
  const [saved, setSaved] = useState<SavedDraft>({
    theme: workspace.draft.theme as Theme,
    revision: workspace.draft.revision,
    basePublishedRevision: workspace.draft.basePublishedRevision,
  });
  const [published, setPublished] = useState({ theme: workspace.published.theme as Theme, revision: workspace.published.revision });
  /** The editor's own version last saved (the server may have trimmed it): unsaved means different from this. */
  const [lastSent, setLastSent] = useState<Theme>(workspace.draft.theme as Theme);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<{ for: Theme; message: string | null; sections: SectionIssues } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<number | null>(null);
  const [draftAction, setDraftAction] = useState(false);
  const [lastPublished, setLastPublished] = useState(workspace.lastPublished);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const dispatch = useCallback((action: Parameters<typeof dispatchHistory>[0]) => {
    setPreviewRevision(null);
    dispatchHistory(action);
  }, []);
  const [page, setPage] = useState<EditorPage>("home");
  const [templatePreviewPaths, setTemplatePreviewPaths] = useState<Partial<Record<FixedEditorPage, string>>>({});
  const [templatePreviewInputs, setTemplatePreviewInputs] = useState<Partial<Record<FixedEditorPage, string>>>({});
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [pane, setPane] = useState<"settings" | "preview">("settings");
  const [tab, setTab] = useState<"sections" | "theme" | "history">("sections");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const preview = useRef<PreviewController>(null);
  const appSections = useMemo(() => appSectionsByKey(workspace.apps), [workspace.apps]);
  const sectionName = useSectionName(appSections);
  const resolved = resolveThemeForStore(theme, storeShape);
  const fitReason = useFitReason(resolved.facts);
  const openPreview = useOpenThemePreview();

  const invalid = themeDraftInvalid(theme)
    || !storefrontThemeDocumentSchema.safeParse(theme).success
    || appSectionsInvalid([...theme.pages.home, ...Object.values(theme.pages.landing).flatMap((each) => each.sections)], appSections);
  const dirty = !same(theme, lastSent);
  const failedHere = failure !== null && same(failure.for, theme);

  const setDraft: SetTheme = useCallback((next) => {
    dispatch({ type: "edit", update: (current) => (typeof next === "function" ? next(current) : next), at: Date.now() });
  }, [dispatch]);

  // ── Saving ───────────────────────────────────────────────────────────────
  const latest = useRef({ theme, saved, saving, conflict, draftAction });
  latest.current = { theme, saved, saving, conflict, draftAction };

  const save = useCallback(async () => {
    const { theme: sending, saved: base, saving: busy, conflict: blocked } = latest.current;
    if (busy || blocked || latest.current.draftAction) return;
    setSaving(true);
    try {
      const result = await apiData(postApiV1AdminSettingsThemeDraft({
        body: { expectedDraftRevision: base.revision, basePublishedRevision: base.basePublishedRevision, theme: sending },
      }));
      const next: SavedDraft = { theme: result.theme as Theme, revision: result.revision, basePublishedRevision: result.basePublishedRevision };
      setSaved(next);
      setLastSent(sending);
      setFailure(null);
      queryClient.setQueryData(themeWorkspaceQueryOptions().queryKey, (previous) => previous && { ...previous, draft: result });
      // The preview follows the saved draft: swap the changed sections, or load the page again.
      const change = base.revision === 0 ? { kind: "reload" as const } : previewChange(base.theme, next.theme);
      if (change.kind === "sections") preview.current?.send({ type: "section-updated", sectionIds: change.ids });
      else if (change.kind === "reload") preview.current?.send({ type: "reload" });
    } catch (error) {
      if (isAdminApiConflictError(error)) setConflict(true);
      else setFailure({ for: sending, ...((issues) => ({ message: issues.other, sections: issues.sections }))(sectionIssues(error, sending)) });
    } finally {
      setSaving(false);
    }
  }, [queryClient]);

  // Edits save themselves a moment after the last one.
  useEffect(() => {
    if (!dirty || invalid || saving || conflict || failedHere || draftAction) return;
    const timer = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [theme, dirty, invalid, saving, conflict, failedHere, draftAction, save]);

  // A store without a draft gets one, so the preview has a draft to render.
  useEffect(() => {
    if (saved.revision === 0 && !saving && !conflict && !failure) void save();
  }, [saved.revision, saving, conflict, failure, save]);

  const loadChanges = async (overwrite = false) => {
    setDraftAction(true);
    try {
      const { data } = await refetch();
      if (!data) return;
      const newer: SavedDraft = { theme: data.draft.theme as Theme, revision: data.draft.revision, basePublishedRevision: data.draft.basePublishedRevision };
      setSaved(newer);
      setLastSent(newer.theme);
      setPublished({ theme: data.published.theme as Theme, revision: data.published.revision });
      setLastPublished(data.lastPublished);
      if (!overwrite) dispatch({ type: "replace", theme: newer.theme });
      setConflict(false);
      setFailure(null);
      setPreviewRevision(null);
      preview.current?.send({ type: "reload" });
    } catch (error) { toast.error(actionErrorText(error)); }
    finally { setDraftAction(false); }
  };

  const resetDraft = async (sourceRevision?: number) => {
    setDraftAction(true);
    try {
      const body = { expectedDraftRevision: saved.revision, basePublishedRevision: saved.basePublishedRevision };
      const result = sourceRevision === undefined
        ? await apiData(postApiV1AdminSettingsThemeDiscard({ body }))
        : await apiData(postApiV1AdminSettingsThemeRestore({ body: { ...body, sourceRevision } }));
      const next = { theme: result.draft.theme as Theme, revision: result.draft.revision, basePublishedRevision: result.draft.basePublishedRevision };
      setSaved(next); setLastSent(next.theme);
      dispatch({ type: "replace", theme: next.theme });
      setPublished({ theme: result.published.theme as Theme, revision: result.published.revision });
      setLastPublished(result.lastPublished);
      setFailure(null); setConflict(false); setPreviewRevision(null); setSelectedId(null);
      if (page.startsWith("landing:") && !next.theme.pages.landing[page.slice(8)]) setPage("home");
      queryClient.setQueryData(themeWorkspaceQueryOptions().queryKey, (previous) => previous && { ...previous, ...result });
      preview.current?.send({ type: "reload" });
      toast.success(t(sourceRevision === undefined ? "discarded" : "restored"));
    } catch (error) {
      if (isAdminApiConflictError(error)) setConflict(true);
      else toast.error(actionErrorText(error));
    } finally { setDraftAction(false); }
  };

  const publish = async () => {
    setPublishing(true);
    try {
      const result = await apiData(postApiV1AdminSettingsThemePublish({
        body: { expectedPublishedRevision: published.revision, expectedDraftRevision: saved.revision, ...(publishNote.trim() ? { note: publishNote.trim() } : {}) },
      }));
      queryClient.setQueryData(themeWorkspaceQueryOptions().queryKey, (previous) => previous && { ...previous, ...result });
      setPublished({ theme: result.published.theme as Theme, revision: result.published.revision });
      // Publishing moves the draft onto the new live revision: later saves start from it.
      setSaved({ theme: result.draft.theme as Theme, revision: result.draft.revision, basePublishedRevision: result.draft.basePublishedRevision });
      setLastPublished(result.lastPublished);
      setPublishNote("");
      void queryClient.invalidateQueries({ queryKey: themeVersionsKey });
      toast.success(store("themePublished"));
    } catch (error) {
      if (isAdminApiConflictError(error)) setConflict(true);
      else toast.error(actionErrorText(error));
    } finally {
      setPublishing(false);
    }
  };

  // ── Undo and redo (outside text fields, which keep their own) ────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typingIn(event.target)) return;
      if (matchesShortcut("undo", event)) {
        event.preventDefault();
        dispatch({ type: "undo" });
      } else if (matchesShortcut("redo", event)) {
        event.preventDefault();
        dispatch({ type: "redo" });
      } else if (matchesShortcut("save", event)) {
        event.preventDefault();
        if (dirty && !invalid) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, invalid, save, dispatch]);

  // ── Sections ─────────────────────────────────────────────────────────────
  const landingSlug = page.startsWith("landing:") ? page.slice(8) : null;
  const sections = useMemo(() => landingSlug ? theme.pages.landing[landingSlug]?.sections ?? [] : theme.pages.home, [landingSlug, theme.pages]);
  const fixedPage = page !== "home" && !landingSlug ? page as FixedEditorPage : null;
  const previewPath = landingSlug ? `/pages/${landingSlug}` : page === "search" ? "/search" : fixedPage ? templatePreviewPaths[fixedPage] ?? "/" : "/";
  const previewReady = !fixedPage || fixedPage === "search" || Boolean(templatePreviewPaths[fixedPage]);
  useEffect(() => {
    if (landingSlug && !theme.pages.landing[landingSlug]) { setPage("home"); setSelectedId(null); }
  }, [landingSlug, theme.pages.landing]);
  const selected = sections.find((section) => section.id === selectedId) ?? null;
  const setSections = (update: (sections: Section[]) => Section[]) =>
    setDraft((current) => ({ ...current, pages: landingSlug
      ? { ...current.pages, landing: { ...current.pages.landing, [landingSlug]: { ...current.pages.landing[landingSlug]!, sections: update(current.pages.landing[landingSlug]!.sections) } } }
      : { ...current.pages, home: update(current.pages.home) } }));
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setTab("sections");
  }, []);

  /** Why buyers don't see a platform section (an app section's panel says it about its app). */
  const note = (section: Section): string | undefined => {
    if (section.hidden) return t("hidden");
    if (isStorefrontAppSection(section)) return undefined;
    if (storefrontSectionRenderer(section) === null) return store("sectionNotYet");
    const fallback = resolved.fallbacks.find((each) => each.kind === "section" && each.key === section.id);
    if (fallback) return store("sectionHidden", { reason: fitReason(fallback) });
    const failed = failedFitConditions(STOREFRONT_SECTION_REGISTRY[section.type].requires, { facts: resolved.facts, blocks: {} });
    if (failed.length > 0) return store("sectionHidden", { reason: fitReason({ failed }) });
    if (storefrontSectionNeedsContent(section)) return store("sectionNeedsContent");
    return undefined;
  };
  /** An app section's row: which app draws it, that its app is not active, or that its values need fixing. */
  const appRowInfo = (section: StorefrontAppSection, name: string): SectionRowInfo => {
    const entry = appSections.get(section.settings.app);
    if (section.hidden) return { name, note: t("hidden") };
    if (!entry) return { name, note: t("appInactive") };
    if (appValuesInvalid(entry.section.settings, section.settings.values)) return { name, note: t("appSettingsInvalid"), invalid: true };
    return { name, note: t("appFrom", { app: entry.app.name }) };
  };
  const rowInfo = (section: Section): SectionRowInfo => {
    const name = sectionName(section);
    const issues = failedHere ? failure?.sections.get(section.id) : undefined;
    if (issues?.size) return { name, note: [...issues.values()][0], invalid: true };
    return isStorefrontAppSection(section) ? appRowInfo(section, name) : { name, note: note(section) };
  };

  const remove = (id: string) => {
    const result = removeSection(sections, id);
    if (!result) return;
    setSections(() => result.sections);
    if (selectedId === id) setSelectedId(null);
    toast.success(t("removed"), {
      duration: 10_000,
      action: {
        label: t("undoRemove"),
        onClick: () => setSections((current) => restoreSection(current, result.removed, result.index)),
      },
    });
  };

  const platformOptions = STOREFRONT_SECTION_RENDERERS.map((type) => {
    const failed = failedFitConditions(STOREFRONT_SECTION_REGISTRY[type].requires, {
      facts: resolved.facts,
      blocks: {},
    });
    const allowed = canAddSectionType(sections, type);
    return {
      value: type,
      label: store(`section_${type}` as MessageKey),
      description: !allowed && sections.length < STOREFRONT_MAX_SECTIONS
        ? t("onePerPage")
        : failed.length > 0 ? `${t(`sectionDescription_${type}`)} ${fitReason({ failed })}` : t(`sectionDescription_${type}`),
      disabled: !allowed,
    };
  });
  // The active apps' sections, under their own heading (with the app's name beside each).
  const appAllowed = canAddSectionType(sections, "app");
  const appOptions = workspace.apps.flatMap((app) => app.sections.map((section) => ({
    value: `${APP_OPTION}${section.key}`,
    label: section.name,
    description: !appAllowed && sections.length < STOREFRONT_MAX_SECTIONS
      ? t("appSectionLimit", { count: PLUGIN_HOME_SECTIONS_MAX })
      : section.description ? `${section.description} ${t("appFrom", { app: app.name })}` : app.name,
    group: t("addGroupApps"),
    disabled: !appAllowed,
  })));
  const addOptions = appOptions.length > 0
    ? [...platformOptions.map((option) => ({ ...option, group: t("addGroupSections") })), ...appOptions]
    : platformOptions;
  const add = (value: string) => {
    if (value.startsWith(APP_OPTION)) {
      const key = value.slice(APP_OPTION.length);
      const entry = appSections.get(key);
      return entry ? addAppSection(sections, key, appSettingDefaults(entry.section.settings)) : null;
    }
    return addSection(sections, value as StorefrontSectionType);
  };

  const names = useMemo(() => Object.fromEntries(sections.map((section) => [section.id, sectionName(section)])), [sections, sectionName]);

  // ── Status ───────────────────────────────────────────────────────────────
  const hasUnpublishedDraft = dirty || (saved.revision > 0 && !same(saved.theme, published.theme));
  const status = conflict ? t("statusConflict")
    : saving ? t("statusSaving")
      : failedHere ? (failure?.message ?? t("statusFailed"))
        : invalid && dirty ? t("statusInvalid")
          : dirty ? t("statusUnsaved")
            : saved.revision > 0 ? t("statusSaved") : "";
  const statusTone = conflict || failedHere || (invalid && dirty) ? "text-destructive" : "text-muted-foreground";

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border bg-card px-2 py-1.5 sm:px-3">
        <Link
          to="/admin/online-store/theme"
          aria-label={t("back")}
          className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground lg:size-9"
        >
          <ArrowLeft className="size-5" aria-hidden="true" />
        </Link>
        <div className="mr-auto min-w-0">
          <h1 className="flex items-center gap-2 text-heading-sm">
            {t("title")}
            <Badge variant={hasUnpublishedDraft ? "attention" : "success"}>{hasUnpublishedDraft ? t("notPublished") : t("live")}</Badge>
          </h1>
          <p role="status" aria-live="polite" className={cn("truncate text-body", statusTone)}>{status}</p>
          {lastPublished?.createdAt ? <p className="text-body text-muted-foreground">{t("lastPublished", { name: lastPublished.publishedByName ?? t("unknownAuthor"), time: formatDateTime(new Date(lastPublished.createdAt), { dateStyle: "medium", timeStyle: "short" }) })}</p> : null}
        </div>
        <div role="group" aria-label={t("device")} className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {DEVICES.map(({ value, icon: Icon }) => (
            <Button
              key={value}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t(`device_${value}`)}
              aria-pressed={device === value}
              onClick={() => setDevice(value)}
            >
              <Icon aria-hidden="true" />
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon" aria-label={t("undo")} aria-keyshortcuts="Meta+Z Control+Z" disabled={history.past.length === 0} onClick={() => dispatch({ type: "undo" })}>
            <Undo2 aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label={t("redo")} aria-keyshortcuts="Meta+Shift+Z Control+Y" disabled={history.future.length === 0} onClick={() => dispatch({ type: "redo" })}>
            <Redo2 aria-hidden="true" />
          </Button>
        </div>
        <Button type="button" variant="outline" disabled={!dirty || invalid || conflict || draftAction} loading={saving} onClick={() => void save()}>
          {t("save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          title={t("previewHelp")}
          disabled={dirty || saved.revision < 1 || !previewReady}
          onClick={() => void openPreview(saved.revision, previewPath, "full", previewRevision ?? undefined)}
        >
          {t("preview")}
        </Button>
        <Button type="button" disabled={dirty || saving || !hasUnpublishedDraft || conflict || draftAction || invalid} loading={publishing} onClick={() => setConfirmPublish(true)}>
          {t("publish")}
        </Button>
      </header>

      {conflict ? <div className="border-b border-border bg-card p-3"><Alert variant="warning"><AlertDescription>{t("statusConflict")}</AlertDescription><div className="mt-2 flex flex-wrap gap-2"><Button type="button" variant="outline" loading={draftAction} onClick={() => void loadChanges()}>{t("reloadDraft")}</Button><Button type="button" variant="outline" disabled={invalid || draftAction} onClick={() => void loadChanges(true)}>{t("overwriteDraft")}</Button></div></Alert></div> : null}
      <div className="flex border-b border-border bg-card px-2 py-1.5 lg:hidden" role="group" aria-label={t("panePreview")}>
        {(["settings", "preview"] as const).map((value) => (
          <Button key={value} type="button" variant="ghost" size="sm" aria-pressed={pane === value} className="flex-1" onClick={() => setPane(value)}>
            {value === "settings" ? t("paneSettings") : t("panePreview")}
          </Button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "@container min-h-0 w-full shrink-0 overflow-y-auto border-r border-border bg-card lg:block lg:w-80 xl:w-96",
            pane === "settings" ? "block" : "hidden",
          )}
          inert={draftAction}
        >
          <PageSelector theme={theme} page={page} setDraft={setDraft} onPage={(next) => { setPage(next); setSelectedId(null); setPreviewRevision(null); }} />
          {selected ? (
            <SectionPanel
              title={isStorefrontAppSection(selected) ? appSectionName(selected, appSections) : store(`section_${selected.type}` as MessageKey)}
              note={note(selected)}
              onBack={() => setSelectedId(null)}
            >
              {isStorefrontAppSection(selected) ? (
                <AppSectionSettings
                  key={selected.id}
                  section={selected}
                  entry={appSections.get(selected.settings.app)}
                  issues={failedHere ? failure?.sections.get(selected.id) : undefined}
                  onChange={(values) => setSections((current) => setAppSectionValues(current, selected.id, values))}
                />
              ) : (
                <PlatformSectionSettings
                  key={selected.id}
                  section={selected}
                  issues={failedHere ? failure?.sections.get(selected.id) : undefined}
                  media={media}
                  onChange={(settings) => setSections((current) => current.map((each) =>
                    each.id === selected.id ? { ...each, settings } as Section : each))}
                />
              )}
            </SectionPanel>
          ) : (
            <Tabs value={tab} onValueChange={(value) => setTab(value as "sections" | "theme" | "history")}>
              <div className="sticky top-0 z-10 border-b border-border bg-card px-2 py-1.5">
                <TabsList className="w-full">
                  <TabsTrigger value="sections" className="flex-1">{t("tabSections")}</TabsTrigger>
                  <TabsTrigger value="theme" className="flex-1">{t("tabTheme")}</TabsTrigger>
                  <TabsTrigger value="history" className="flex-1">{t("history")}</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="sections" className="mt-0">
                <SettingsGroup title={landingSlug ? theme.pages.landing[landingSlug]?.title : t(`page_${page as "home" | "product" | "collection" | "search"}`)}>
                  {landingSlug ? <LandingSettings slug={landingSlug} theme={theme} setDraft={setDraft} /> : null}
                  {fixedPage ? <><TemplateBlocks page={fixedPage} theme={theme} setDraft={setDraft} />{fixedPage !== "search" ? <div className="space-y-1"><Label htmlFor="template-preview-path">{t("previewPath")}</Label><Input id="template-preview-path" value={templatePreviewInputs[fixedPage] ?? ""} onChange={(event) => setTemplatePreviewInputs((current) => ({ ...current, [fixedPage]: event.target.value }))} aria-invalid={Boolean(templatePreviewInputs[fixedPage]) && !validTemplatePath(fixedPage, templatePreviewInputs[fixedPage] ?? "")} placeholder={fixedPage === "product" ? "/products/product-handle" : "/categories/category-handle"} onBlur={() => { const path = templatePreviewInputs[fixedPage] ?? ""; setTemplatePreviewPaths((current) => ({ ...current, [fixedPage]: validTemplatePath(fixedPage, path) ? path : undefined })); }} aria-describedby="template-preview-path-help" /><p id="template-preview-path-help" className="text-body text-muted-foreground">{t("previewPathHelp")}</p></div> : null}</> : <>
                  {page === "home" && theme.pages.homeMode.kind === "product" ? (
                    <p role="status" className="text-body text-muted-foreground">{t("homeIsProduct")}</p>
                  ) : null}
                  {sections.length === 0 ? <p className="text-body text-muted-foreground">{t("noSections")}</p> : null}
                  <SectionList
                    sections={sections}
                    info={rowInfo}
                    canDuplicate={(section) => canAddSectionType(sections, section.type)}
                    onSelect={select}
                    onHover={(id) => preview.current?.send({ type: "highlight", sectionId: id })}
                    onMove={(id, to) => setSections((current) => moveSectionTo(current, current.findIndex((each) => each.id === id), to))}
                    onDuplicate={(id) => {
                      const result = duplicateSection(sections, id);
                      if (result) setSections(() => result.sections);
                    }}
                    onRemove={remove}
                    onToggle={(id) => setSections((current) => current.map((section) => section.id === id ? { ...section, hidden: !section.hidden } : section))}
                  />
                  <SectionPicker options={addOptions} disabled={sections.length >= STOREFRONT_MAX_SECTIONS} onAdd={(value) => {
                    const result = add(value);
                    if (!result) return;
                    setSections(() => result.sections); setSelectedId(result.id);
                  }} />
                  {sections.length >= STOREFRONT_MAX_SECTIONS ? (
                    <p className="text-body text-muted-foreground">{store("sectionLimit", { count: STOREFRONT_MAX_SECTIONS })}</p>
                  ) : null}
                  </>}
                </SettingsGroup>
              </TabsContent>
              <TabsContent value="history" className="mt-0"><ThemeHistory theme={theme} sectionName={sectionName} busy={saving || draftAction || conflict} previewRevision={previewRevision} onPreview={setPreviewRevision} onRestore={setPendingRestore} /><div className="p-4"><Button type="button" variant="outline" disabled={saving || draftAction || conflict || !hasUnpublishedDraft} onClick={() => setConfirmDiscard(true)}>{t("discard")}</Button></div></TabsContent>
              <TabsContent value="theme" className="mt-0">
                <ThemeSettingsPanel theme={theme} resolved={resolved} media={media} setDraft={setDraft} />
              </TabsContent>
            </Tabs>
          )}
        </aside>
        <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-2 bg-muted p-2 sm:p-3 lg:flex", pane === "preview" ? "flex" : "hidden")}>
          {previewRevision !== null ? <div className="flex items-center justify-between gap-2 rounded-lg bg-card px-3 py-2"><p className="text-body">{t("version", { revision: previewRevision })}</p><Button type="button" variant="outline" size="sm" onClick={() => setPreviewRevision(null)}>{t("currentDraft")}</Button></div> : null}
          {saved.revision > 0 && previewReady ? (
            <PreviewFrame
              draftRevision={saved.revision}
              sourceRevision={previewRevision ?? undefined}
              previewPath={previewPath}
              device={device}
              names={names}
              selectedId={selectedId}
              onSelect={(id) => {
                select(id);
                setPane("settings");
              }}
              controller={preview}
            />
          ) : (
            <p role="status" className="p-6 text-center text-body text-muted-foreground">{t(previewReady ? "previewLoading" : "previewPathHelp")}</p>
          )}
        </main>
      </div>

      <UnsavedChangesGuard isDirty={dirty} isSubmitting={false} />
      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{store("themePublishConfirmTitle")}</AlertDialogTitle><AlertDialogDescription>{store("themePublishConfirmBody")}</AlertDialogDescription></AlertDialogHeader>
          <div className="space-y-1"><Label htmlFor="theme-publish-note">{t("publishNote")}</Label><Textarea id="theme-publish-note" maxLength={500} value={publishNote} onChange={(event) => setPublishNote(event.target.value)} aria-describedby="theme-publish-note-help" /><p id="theme-publish-note-help" className="text-body text-muted-foreground">{t("publishNoteHelp")}</p></div>
          <AlertDialogFooter><AlertDialogCancel>{store("cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => { setConfirmPublish(false); void publish(); }}>{store("themePublish")}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConfirmDialog open={confirmDiscard} onOpenChange={setConfirmDiscard} title={t("discardTitle")} description={t("discardBody")} confirmLabel={t("discard")} onConfirm={() => { setConfirmDiscard(false); void resetDraft(); }} />
      <ConfirmDialog open={pendingRestore !== null} onOpenChange={(open) => { if (!open) setPendingRestore(null); }} title={t("restoreTitle", { revision: pendingRestore ?? "" })} description={t("restoreBody")} confirmLabel={t("restore")} variant="default" onConfirm={() => { const revision = pendingRestore; setPendingRestore(null); if (revision !== null) void resetDraft(revision); }} />
    </div>
  );
}

export function ThemeEditorPage() {
  const { data: workspace, refetch } = useSuspenseQuery(themeWorkspaceQueryOptions());
  return <ThemeEditor workspace={workspace} refetch={refetch} />;
}
