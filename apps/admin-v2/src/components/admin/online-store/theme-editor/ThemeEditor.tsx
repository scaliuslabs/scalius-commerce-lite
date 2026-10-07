/**
 * The theme editor (Online store → Themes → Customize), Shopify's shape:
 *
 * - a top bar: back, the theme's state (live, or a draft with unpublished
 *   changes, and who published last), the page picker, the preview width,
 *   undo and redo, versions, view in a new tab, Save and Publish;
 * - a left panel with the page's tree (header, the page's sections or
 *   blocks, footer) and a Theme settings tab (colours, fonts, logo, cards);
 * - the real storefront in the middle, rendering the saved draft, where a
 *   click selects a section or block and hovering outlines it;
 * - the selected item's settings beside it (wide screens) or in the left
 *   panel's place (narrower ones).
 *
 * Edits go to the shared draft by themselves (debounced, against the draft
 * revision they started from); a settings change re-renders only its section
 * in the preview, anything else reloads the page. Publishing makes the saved
 * draft live; versions restore to the draft only.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, History, Laptop, Monitor, MoreHorizontal, Redo2, Smartphone, Trash2, Undo2 } from "lucide-react";
import { toast } from "~/lib/toast";
import {
  postApiV1AdminSettingsThemeDiscard,
  postApiV1AdminSettingsThemeDraft,
  postApiV1AdminSettingsThemePublish,
  postApiV1AdminSettingsThemeRestore,
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
import { Alert, AlertDescription } from "~/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "~/components/ui/alert-dialog";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Label } from "~/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { matchesShortcut, typingIn } from "~/components/admin/layout/shortcuts";
import { useMediaQuery } from "~/hooks/use-media-query";
import { formatDateTime, useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { AdminApiResponseError, isAdminApiConflictError } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import type { NavigationResourceOption } from "~/lib/api-query-options/navigation";
import { themeWorkspaceQueryOptions, type ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { SectionSettingsForm, useSectionErrors } from "../SectionSettings";
import { appSettingDefaults, appValuesInvalid } from "../schema-form/app-settings";
import { useMediaPreviews } from "../schema-form/resource-fields";
import { actionErrorText } from "../shared";
import { useFitReason, type SetTheme } from "../theme-fields";
import { productAppBlocksInvalid, appBlocksByKey, resolveThemeForStore, themeDraftInvalid } from "../theme-settings";
import { useOpenThemePreview } from "../theme-preview";
import { AppSectionSettings } from "./AppSectionSettings";
import {
  EDITOR_PARTS,
  PRODUCT_MODULES,
  isResourcePage,
  moduleId,
  pageSections,
  previewPath,
  samePage,
  withPageSections,
  type EditorPage,
  type ResourcePageKind,
} from "./editor-pages";
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
import { CreateLandingDialog, PagePicker, PreviewResource, useDefaultResource, usePageName } from "./PagePicker";
import { PageTree } from "./PageTree";
import { PreviewFrame, type PreviewController, type PreviewDevice } from "./PreviewFrame";
import type { TreeRow } from "./SectionList";
import { SectionPicker } from "./SectionPicker";
import { PartSettings, SettingsPanel, usePartTitle } from "./SettingsPanel";
import { ThemeHistory, themeVersionDocumentQuery, themeVersionsKey } from "./ThemeHistory";
import { ThemeSettingsPanel } from "./ThemeSettingsPanel";

type Theme = StorefrontThemeDocument;
type Section = StorefrontSection;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** How long the editor waits after the last edit before saving the draft. */
export const AUTOSAVE_DELAY_MS = 800;

const same = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

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
    const match = /^(?:theme\.)?pages\.(?:home|landing\.([^.]+)\.sections)\.(\d+)\.settings\.?(.*)$/.exec(issue.path);
    const list = match?.[1] ? theme.pages.landing[match[1]]?.sections : theme.pages.home;
    const id = match ? list?.[Number(match[2])]?.id : undefined;
    if (id) {
      const map = sections.get(id) ?? new Map<string, string>();
      map.set(match![3] ?? "", issue.message);
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
  return useCallback((section: Section) => {
    if (isStorefrontAppSection(section)) return appSectionName(section, apps);
    const settings = section.settings as { title?: unknown; heading?: unknown };
    const own = [settings.title, settings.heading].find((value): value is string => typeof value === "string" && value.trim() !== "");
    return own?.trim() || t(`section_${section.type}` as MessageKey);
  }, [apps, t]);
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
  const [lastPublished, setLastPublished] = useState(workspace.lastPublished);
  /** The editor's own version last saved: unsaved means different from this. */
  const [lastSent, setLastSent] = useState<Theme>(workspace.draft.theme as Theme);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<{ for: Theme; message: string | null; sections: SectionIssues } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<number | null>(null);
  /** A version that names images deleted from Files since: how many, before restoring it without them. */
  const [restoreMissing, setRestoreMissing] = useState<{ revision: number; images: number } | null>(null);
  const [pendingRemoveLanding, setPendingRemoveLanding] = useState<string | null>(null);
  const [draftAction, setDraftAction] = useState(false);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [creatingLanding, setCreatingLanding] = useState(false);
  const [page, setPageState] = useState<EditorPage>({ kind: "home" });
  const [resources, setResources] = useState<Partial<Record<ResourcePageKind, NavigationResourceOption>>>({});
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [pane, setPane] = useState<"panel" | "preview">("panel");
  const [tab, setTab] = useState<"sections" | "theme">("sections");
  const [selected, setSelected] = useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 1280px)");
  // Staff who may view settings but not edit them browse the theme read-only.
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const preview = useRef<PreviewController>(null);
  const appSections = useMemo(() => appSectionsByKey(workspace.apps), [workspace.apps]);
  const appBlocks = useMemo(() => appBlocksByKey(workspace.apps), [workspace.apps]);
  const sectionName = useSectionName(appSections);
  const pageName = usePageName();
  const partTitle = usePartTitle();
  const resolved = resolveThemeForStore(theme, storeShape);
  const fitReason = useFitReason(resolved.facts);
  const openPreview = useOpenThemePreview();

  const dispatch = useCallback((action: Parameters<typeof dispatchHistory>[0]) => {
    // Editing returns the preview from a published version to the draft.
    setPreviewRevision(null);
    dispatchHistory(action);
  }, []);
  const setDraft: SetTheme = useCallback((next) => {
    if (!canEdit) return;
    dispatch({ type: "edit", update: (current) => (typeof next === "function" ? next(current) : next), at: Date.now() });
  }, [dispatch, canEdit]);

  const sections = pageSections(theme, page);
  const allSections = useMemo(
    () => [...theme.pages.home, ...Object.values(theme.pages.landing).flatMap((each) => each.sections)],
    [theme.pages.home, theme.pages.landing],
  );
  const invalid = themeDraftInvalid(theme)
    || !storefrontThemeDocumentSchema.safeParse(theme).success
    || appSectionsInvalid(allSections, appSections)
    || productAppBlocksInvalid(theme, appBlocks);
  const dirty = !same(theme, lastSent);
  const failedHere = failure !== null && same(failure.for, theme);

  // ── Saving ───────────────────────────────────────────────────────────────
  const latest = useRef({ theme, saved, saving, conflict, draftAction, page });
  latest.current = { theme, saved, saving, conflict, draftAction, page };

  const save = useCallback(async () => {
    const { theme: sending, saved: base, saving: busy, conflict: blocked, draftAction: replacing, page: shown } = latest.current;
    if (busy || blocked || replacing) return;
    setSaving(true);
    try {
      const result = await apiData(postApiV1AdminSettingsThemeDraft({
        body: { expectedDraftRevision: base.revision, basePublishedRevision: base.basePublishedRevision, theme: sending },
      }));
      setSaved({ theme: sending, revision: result.revision, basePublishedRevision: result.basePublishedRevision });
      setLastSent(sending);
      setFailure(null);
      // The preview follows the saved draft: swap the changed sections, or load the page again.
      const change = base.revision === 0 ? { kind: "reload" as const } : previewChange(base.theme, sending, shown);
      if (change.kind === "sections") preview.current?.send({ type: "section-updated", sectionIds: change.ids });
      else if (change.kind === "reload") preview.current?.send({ type: "reload" });
    } catch (error) {
      if (isAdminApiConflictError(error)) setConflict(true);
      else {
        const issues = sectionIssues(error, sending);
        setFailure({ for: sending, message: issues.other, sections: issues.sections });
      }
    } finally {
      setSaving(false);
    }
  }, []);

  // Edits save themselves a moment after the last one.
  useEffect(() => {
    if (!canEdit || !dirty || invalid || saving || conflict || failedHere || draftAction) return;
    const timer = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [theme, canEdit, dirty, invalid, saving, conflict, failedHere, draftAction, save]);

  // A store without a draft gets one, so the preview has a draft to render.
  useEffect(() => {
    if (canEdit && saved.revision === 0 && !saving && !conflict && !failure) void save();
  }, [canEdit, saved.revision, saving, conflict, failure, save]);

  /** The server's workspace again (after a conflict, a restore or a discard); `keepEdits` overwrites it with ours next. */
  const reload = async (keepEdits = false) => {
    setDraftAction(true);
    try {
      const { data } = await refetch();
      if (!data) return;
      const newer: SavedDraft = { theme: data.draft.theme as Theme, revision: data.draft.revision, basePublishedRevision: data.draft.basePublishedRevision };
      setSaved(newer);
      setLastSent(newer.theme);
      setPublished({ theme: data.published.theme as Theme, revision: data.published.revision });
      setLastPublished(data.lastPublished);
      if (!keepEdits) dispatchHistory({ type: "replace", theme: newer.theme });
      setConflict(false);
      setFailure(null);
      setPreviewRevision(null);
      if (page.kind === "landing" && !(data.draft.theme as Theme).pages.landing[page.slug] && !keepEdits) setPageState({ kind: "home" });
      preview.current?.send({ type: "reload" });
    } catch (error) {
      toast.error(actionErrorText(error));
    } finally {
      setDraftAction(false);
    }
  };

  /**
   * Restore a published version to the draft, or discard the draft's changes
   * (no revision). A version naming images deleted from Files since asks
   * first, then restores without them.
   */
  const replaceDraft = async (sourceRevision?: number, withoutMissingImages = false) => {
    setDraftAction(true);
    try {
      const body = { expectedDraftRevision: saved.revision, basePublishedRevision: saved.basePublishedRevision };
      if (sourceRevision === undefined) await apiData(postApiV1AdminSettingsThemeDiscard({ body }));
      else await apiData(postApiV1AdminSettingsThemeRestore({ body: { ...body, sourceRevision, ...(withoutMissingImages ? { withoutMissingImages } : {}) } }));
      setSelected(null);
      toast.success(t(sourceRevision === undefined ? "discarded" : "restored"));
    } catch (error) {
      if (isAdminApiConflictError(error)) setConflict(true);
      else if (sourceRevision !== undefined && error instanceof AdminApiResponseError && error.code === "THEME_VERSION_IMAGES_MISSING") {
        const images = (error.details as { missingImages?: unknown } | undefined)?.missingImages;
        setRestoreMissing({ revision: sourceRevision, images: typeof images === "number" ? images : 1 });
      } else toast.error(actionErrorText(error));
      setDraftAction(false);
      return;
    }
    await reload();
  };

  const publish = async () => {
    setPublishing(true);
    try {
      const result = await apiData(postApiV1AdminSettingsThemePublish({
        body: { expectedPublishedRevision: published.revision, expectedDraftRevision: saved.revision, ...(publishNote.trim() ? { note: publishNote.trim() } : {}) },
      }));
      setPublished({ theme: saved.theme, revision: result.published.revision });
      // Publishing moves the draft onto the new live revision: later saves start from it.
      setSaved({ theme: saved.theme, revision: result.draft.revision, basePublishedRevision: result.draft.basePublishedRevision });
      setLastPublished(result.lastPublished);
      setPublishNote("");
      void queryClient.invalidateQueries({ queryKey: themeVersionsKey });
      void queryClient.invalidateQueries({ queryKey: themeWorkspaceQueryOptions().queryKey });
      toast.success(store("themePublished"));
    } catch (error) {
      if (isAdminApiConflictError(error)) setConflict(true);
      else toast.error(actionErrorText(error));
    } finally {
      setPublishing(false);
    }
  };

  // ── Undo, redo and save from the keyboard (outside text fields, which keep their own) ──
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

  // ── Pages and what the preview shows ─────────────────────────────────────
  const setPage = (next: EditorPage) => {
    setPageState(next);
    setSelected(null);
    setTab("sections");
  };
  // A landing page undone or restored away: back to the homepage.
  useEffect(() => {
    if (page.kind === "landing" && !theme.pages.landing[page.slug]) {
      setPageState({ kind: "home" });
      setSelected(null);
    }
  }, [page, theme.pages.landing]);
  const resourceKind = isResourcePage(page) ? page.kind : null;
  const defaults = useDefaultResource(resourceKind);
  const resource = resourceKind ? resources[resourceKind] ?? defaults.resource : null;
  // A published version without this landing page previews its homepage.
  const versionDocument = useQuery(themeVersionDocumentQuery(page.kind === "landing" ? previewRevision : null));
  const versionLacksPage = page.kind === "landing" && previewRevision !== null && versionDocument.data !== undefined && !versionDocument.data.pages.landing[page.slug];
  const path = versionLacksPage ? "/" : previewPath(page, resource?.url ?? null);

  // ── Sections of the homepage or a landing page ───────────────────────────
  const setSections = (update: (sections: Section[]) => Section[]) =>
    setDraft((current) => withPageSections(current, page, update(pageSections(current, page) ?? [])));
  const selectedSection = sections?.find((section) => section.id === selected) ?? null;

  /** Why buyers don't see a platform section (an app section's row says it about its app). */
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
  const appNote = (section: StorefrontAppSection): Pick<TreeRow, "note" | "invalid"> => {
    const entry = appSections.get(section.settings.app);
    if (section.hidden) return { note: t("hidden") };
    if (!entry) return { note: t("appInactive") };
    if (appValuesInvalid(entry.section.settings, section.settings.values)) return { note: t("appSettingsInvalid"), invalid: true };
    return { note: t("appFrom", { app: entry.app.name }) };
  };
  const rows: TreeRow[] = (sections ?? []).map((section) => {
    const issues = failedHere ? failure?.sections.get(section.id) : undefined;
    const base = { id: section.id, name: sectionName(section), hidden: section.hidden === true, canDuplicate: canAddSectionType(sections ?? [], section.type) };
    if (issues?.size) return { ...base, note: [...issues.values()][0], invalid: true };
    return isStorefrontAppSection(section) ? { ...base, ...appNote(section) } : { ...base, note: note(section) };
  });

  const remove = (id: string) => {
    const result = removeSection(sections ?? [], id);
    if (!result) return;
    setSections(() => result.sections);
    if (selected === id) setSelected(null);
    toast.success(t("removed"), {
      duration: 10_000,
      action: { label: t("undoRemove"), onClick: () => setSections((current) => restoreSection(current, result.removed, result.index)) },
    });
  };

  const platformOptions = STOREFRONT_SECTION_RENDERERS.map((type) => {
    const failed = failedFitConditions(STOREFRONT_SECTION_REGISTRY[type].requires, { facts: resolved.facts, blocks: {} });
    const allowed = canAddSectionType(sections ?? [], type);
    return {
      value: type,
      label: store(`section_${type}` as MessageKey),
      description: !allowed && (sections ?? []).length < STOREFRONT_MAX_SECTIONS
        ? t("onePerPage")
        : failed.length > 0 ? `${t(`sectionDescription_${type}`)} ${fitReason({ failed })}` : t(`sectionDescription_${type}`),
      disabled: !allowed,
    };
  });
  const appAllowed = canAddSectionType(sections ?? [], "app");
  const appOptions = workspace.apps.flatMap((app) => app.sections.map((section) => ({
    value: `${APP_OPTION}${section.key}`,
    label: section.name,
    description: !appAllowed && (sections ?? []).length < STOREFRONT_MAX_SECTIONS
      ? t("appSectionLimit", { count: PLUGIN_HOME_SECTIONS_MAX })
      : section.description ? `${section.description} ${t("appFrom", { app: app.name })}` : app.name,
    group: t("addGroupApps"),
    disabled: !appAllowed,
  })));
  const addOptions = appOptions.length > 0
    ? [...platformOptions.map((option) => ({ ...option, group: t("addGroupSections") })), ...appOptions]
    : platformOptions;
  const add = (value: string) => {
    const current = sections ?? [];
    if (value.startsWith(APP_OPTION)) {
      const entry = appSections.get(value.slice(APP_OPTION.length));
      return entry ? addAppSection(current, value.slice(APP_OPTION.length), appSettingDefaults(entry.section.settings)) : null;
    }
    return addSection(current, value as StorefrontSectionType);
  };

  // ── What the preview names (outline labels) and selects ──────────────────
  const names = useMemo<Record<string, string>>(() => {
    // Every page's header, announcement bar and footer, then the page's own parts.
    const frame = { [EDITOR_PARTS.announcement]: t("announcement"), [EDITOR_PARTS.header]: t("headerRow"), [EDITOR_PARTS.footer]: t("footerRow") };
    if (sections) return { ...frame, ...Object.fromEntries(sections.map((section) => [section.id, sectionName(section)])) };
    if (page.kind === "product") {
      return {
        ...frame,
        [EDITOR_PARTS.productMain]: t("productMain"),
        [EDITOR_PARTS.productApps]: t("appBlocks"),
        ...Object.fromEntries(PRODUCT_MODULES.filter((module) => theme.blocks.product.below.includes(module)).map((module) => [moduleId(module), t(`module_${module}`)])),
      };
    }
    if (page.kind === "collection" || page.kind === "category" || page.kind === "search") {
      return { ...frame, [EDITOR_PARTS.listing]: t("listingGrid"), [EDITOR_PARTS.listingFilters]: t("listingFilters") };
    }
    return frame;
  }, [sections, sectionName, page.kind, theme.blocks.product.below, t]);
  const select = (id: string | null) => {
    setSelected(id);
    if (id) setTab("sections");
  };

  // ── Status ───────────────────────────────────────────────────────────────
  const hasUnpublishedDraft = dirty || (saved.revision > 0 && !same(saved.theme, published.theme));
  const status = !canEdit ? t("readOnly")
    : conflict ? t("statusConflict")
    : saving ? t("statusSaving")
      : failedHere ? (failure?.message ?? t("statusFailed"))
        : invalid && dirty ? t("statusInvalid")
          : dirty ? t("statusUnsaved")
            : saved.revision > 0 ? t("statusSaved") : "";
  const statusTone = conflict || failedHere || (invalid && dirty) ? "text-destructive" : "text-muted-foreground";
  const busy = saving || draftAction || conflict;
  const previewReady = saved.revision > 0 && path !== null;
  const homeIsProduct = page.kind === "home" && theme.pages.homeMode.kind === "product";

  // ── The selected item's settings ─────────────────────────────────────────
  const settingsTitle = selectedSection
    ? isStorefrontAppSection(selectedSection) ? appSectionName(selectedSection, appSections) : store(`section_${selectedSection.type}` as MessageKey)
    : selected ? partTitle(selected, page) : null;
  const sectionSettings = selectedSection ? (
    <>
      {isStorefrontAppSection(selectedSection) ? (
        <AppSectionSettings
          key={selectedSection.id}
          section={selectedSection}
          entry={appSections.get(selectedSection.settings.app)}
          issues={failedHere ? failure?.sections.get(selectedSection.id) : undefined}
          onChange={(values) => setSections((current) => setAppSectionValues(current, selectedSection.id, values))}
        />
      ) : (
        <PlatformSectionSettings
          key={selectedSection.id}
          section={selectedSection}
          issues={failedHere ? failure?.sections.get(selectedSection.id) : undefined}
          media={media}
          onChange={(settings) => setSections((current) => current.map((each) => each.id === selectedSection.id ? { ...each, settings } as Section : each))}
        />
      )}
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" size="sm" onClick={() => setSections((current) => current.map((each) => each.id === selectedSection.id ? { ...each, hidden: !each.hidden } : each))}>
          {t(selectedSection.hidden ? "showSection" : "hideSection")}
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={() => remove(selectedSection.id)}>
          <Trash2 aria-hidden="true" />{t("removeSection")}
        </Button>
      </div>
    </>
  ) : null;
  const settingsContent = selected === null ? null : sectionSettings ?? (
    <PartSettings
      selected={selected}
      page={page}
      theme={theme}
      resolved={resolved}
      media={media}
      apps={workspace.apps}
      cmsPageId={page.kind === "page" ? resource?.id ?? null : null}
      setDraft={setDraft}
      onRemoveLanding={setPendingRemoveLanding}
    />
  );
  const settingsPanel = settingsContent && settingsTitle ? (
    <SettingsPanel
      title={settingsTitle}
      note={selectedSection && !isStorefrontAppSection(selectedSection) ? note(selectedSection) : undefined}
      closeLabel={wide ? "close" : "back"}
      onClose={() => setSelected(null)}
    >
      <fieldset disabled={!canEdit} className="min-w-0 space-y-4">{settingsContent}</fieldset>
    </SettingsPanel>
  ) : null;

  const tree = (
    <PageTree
      theme={theme}
      page={page}
      pageName={pageName(page, theme)}
      selected={selected}
      onSelect={select}
      onHover={(id) => preview.current?.send({ type: "highlight", sectionId: id })}
      hasAppBlocks={appBlocks.size > 0 || (theme.blocks.product.apps ?? []).length > 0}
      setDraft={setDraft}
      resource={resourceKind ? (
        <PreviewResource
          kind={resourceKind}
          resource={resource}
          loading={defaults.loading}
          failed={defaults.failed}
          onChange={(next) => setResources((current) => ({ ...current, [resourceKind]: next }))}
        />
      ) : null}
      readOnly={!canEdit}
      sections={sections ? {
        rows,
        note: homeIsProduct ? t("homeIsProduct") : undefined,
        onMove: (id, to) => setSections((current) => moveSectionTo(current, current.findIndex((each) => each.id === id), to)),
        onDuplicate: (id) => {
          const result = duplicateSection(sections, id);
          if (result) setSections(() => result.sections);
        },
        onRemove: remove,
        onToggle: (id) => setSections((current) => current.map((each) => each.id === id ? { ...each, hidden: !each.hidden } : each)),
        footer: (
          <>
            <SectionPicker options={addOptions} disabled={sections.length >= STOREFRONT_MAX_SECTIONS} onAdd={(value) => {
              const result = add(value);
              if (!result) return;
              setSections(() => result.sections);
              setSelected(result.id);
            }} />
            {sections.length >= STOREFRONT_MAX_SECTIONS ? (
              <p className="px-2 pt-2 text-body text-muted-foreground">{store("sectionLimit", { count: STOREFRONT_MAX_SECTIONS })}</p>
            ) : null}
          </>
        ),
      } : null}
    />
  );

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
        <div className="min-w-0 flex-1 basis-40">
          <h1 className="flex items-center gap-2 text-heading-sm">
            <span className="truncate">{t("title")}</span>
            <StatusBadge status={hasUnpublishedDraft ? "draft" : "active"}>{hasUnpublishedDraft ? t("notPublished") : t("live")}</StatusBadge>
          </h1>
          <p role="status" aria-live="polite" className={cn("truncate text-body", statusTone)}>
            {status}
            {lastPublished && !conflict && !failedHere ? (
              <span className="text-muted-foreground">
                {status ? " · " : ""}
                {t("lastPublished", {
                  name: lastPublished.publishedByName ?? t("unknownAuthor"),
                  time: formatDateTime(new Date(lastPublished.createdAt), { dateStyle: "medium", timeStyle: "short" }),
                })}
              </span>
            ) : null}
          </p>
        </div>
        <div className="order-last flex w-full justify-center md:order-none md:w-auto">
          <PagePicker theme={theme} page={page} onPage={setPage} onCreate={canEdit ? () => setCreatingLanding(true) : undefined} />
        </div>
        <div className="ms-auto flex items-center gap-1">
          <div role="group" aria-label={t("device")} className="hidden items-center gap-0.5 rounded-lg bg-muted p-0.5 md:flex">
            {DEVICES.map(({ value, icon: Icon }) => (
              <Button key={value} type="button" variant="ghost" size="icon-sm" aria-label={t(`device_${value}`)} aria-pressed={device === value} onClick={() => setDevice(value)}>
                <Icon aria-hidden="true" />
              </Button>
            ))}
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label={t("undo")} aria-keyshortcuts="Meta+Z Control+Z" disabled={history.past.length === 0} onClick={() => dispatch({ type: "undo" })}>
            <Undo2 aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label={t("redo")} aria-keyshortcuts="Meta+Shift+Z Control+Y" disabled={history.future.length === 0} onClick={() => dispatch({ type: "redo" })}>
            <Redo2 aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={t("moreActions")}>
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setVersionsOpen(true)}>
                <History aria-hidden="true" />{t("versions")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={dirty || saved.revision < 1 || path === null}
                onSelect={() => { if (path) void openPreview(saved.revision, path, "full", previewRevision ?? undefined); }}
              >
                <ExternalLink aria-hidden="true" />{t("preview")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={!canEdit || busy || !hasUnpublishedDraft} onSelect={() => setConfirmDiscard(true)}>
                {t("discard")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canEdit ? (
            <>
              <Button type="button" variant="outline" disabled={!dirty || invalid || conflict || draftAction} loading={saving} onClick={() => void save()}>
                {dirty ? t("save") : t("saved")}
              </Button>
              <Button type="button" disabled={dirty || saving || !hasUnpublishedDraft || conflict || draftAction || invalid} loading={publishing} onClick={() => setConfirmPublish(true)}>
                {t("publish")}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {conflict ? (
        <div className="border-b border-border bg-card p-3">
          <Alert variant="warning">
            <AlertDescription>{t("statusConflict")}</AlertDescription>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="outline" loading={draftAction} onClick={() => void reload()}>{t("reloadDraft")}</Button>
              <Button type="button" variant="outline" disabled={invalid || draftAction} onClick={() => void reload(true)}>{t("overwriteDraft")}</Button>
            </div>
          </Alert>
        </div>
      ) : null}
      <div className="flex border-b border-border bg-card px-2 py-1.5 lg:hidden" role="group" aria-label={t("panePreview")}>
        {(["panel", "preview"] as const).map((value) => (
          <Button key={value} type="button" variant="ghost" size="sm" aria-pressed={pane === value} className="flex-1" onClick={() => setPane(value)}>
            {value === "panel" ? t("paneSettings") : t("panePreview")}
          </Button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "min-h-0 w-full shrink-0 overflow-y-auto border-e border-border bg-card lg:block lg:w-80 xl:w-72",
            pane === "panel" ? "block" : "hidden",
          )}
          inert={draftAction}
        >
          {settingsPanel && !wide ? settingsPanel : (
            <Tabs value={tab} onValueChange={(value) => setTab(value as "sections" | "theme")}>
              <div className="sticky top-0 z-10 border-b border-border bg-card px-2 py-1.5">
                <TabsList className="w-full">
                  <TabsTrigger value="sections" className="flex-1">{t("tabSections")}</TabsTrigger>
                  <TabsTrigger value="theme" className="flex-1">{t("tabTheme")}</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="sections" className="mt-0">{tree}</TabsContent>
              <TabsContent value="theme" className="mt-0">
                <ThemeSettingsPanel theme={theme} resolved={resolved} media={media} setDraft={setDraft} />
              </TabsContent>
            </Tabs>
          )}
        </aside>
        <main className={cn("min-h-0 min-w-0 flex-1 flex-col gap-2 bg-muted p-2 sm:p-3 lg:flex", pane === "preview" ? "flex" : "hidden")}>
          {previewRevision !== null ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-3 py-2 shadow-card" data-version-banner>
              <p className="text-body">{t(versionLacksPage ? "previewingVersionHome" : "previewingVersion", { revision: previewRevision })}</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setPreviewRevision(null)}>{t("currentDraft")}</Button>
                {previewRevision !== published.revision ? (
                  <Button type="button" size="sm" disabled={busy} onClick={() => setPendingRestore(previewRevision)}>{t("restore")}</Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {previewReady ? (
            <PreviewFrame
              draftRevision={saved.revision}
              sourceRevision={previewRevision ?? undefined}
              previewPath={path}
              device={device}
              names={names}
              selectedId={selected}
              onSelect={(id) => {
                select(id);
                setPane("panel");
              }}
              controller={preview}
            />
          ) : (
            <p role="status" className="p-6 text-center text-body text-muted-foreground">
              {resourceKind && !defaults.loading && !resource ? t(defaults.failed ? "resourceFailed" : `resourceNone_${resourceKind}`) : t("previewLoading")}
            </p>
          )}
        </main>
        {settingsPanel && wide ? (
          <aside className="min-h-0 w-80 shrink-0 overflow-y-auto border-s border-border bg-card" inert={draftAction}>
            {settingsPanel}
          </aside>
        ) : null}
      </div>

      <UnsavedChangesGuard isDirty={dirty} isSubmitting={false} />
      <ThemeHistory
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        draft={theme}
        liveRevision={published.revision}
        previewRevision={previewRevision}
        busy={busy || !canEdit}
        sectionName={sectionName}
        onPreview={(revision) => {
          setPreviewRevision(revision);
          setVersionsOpen(false);
          setPane("preview");
        }}
        onRestore={setPendingRestore}
      />
      <CreateLandingDialog
        open={creatingLanding}
        onOpenChange={setCreatingLanding}
        theme={theme}
        onCreate={(slug, title) => {
          setDraft((current) => ({ ...current, pages: { ...current.pages, landing: { ...current.pages.landing, [slug]: { title, description: "", sections: [] } } } }));
          setCreatingLanding(false);
          setPage({ kind: "landing", slug });
        }}
      />
      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{store("themePublishConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{store("themePublishConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor="theme-publish-note">{t("publishNote")}</Label>
            <Textarea id="theme-publish-note" maxLength={500} value={publishNote} onChange={(event) => setPublishNote(event.target.value)} aria-describedby="theme-publish-note-help" />
            <p id="theme-publish-note-help" className="text-body text-muted-foreground">{t("publishNoteHelp")}</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{store("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmPublish(false); void publish(); }}>{store("themePublish")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t("discardTitle")}
        description={t("discardBody")}
        confirmLabel={t("discard")}
        onConfirm={() => { setConfirmDiscard(false); void replaceDraft(); }}
      />
      <ConfirmDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => { if (!open) setPendingRestore(null); }}
        title={t("restoreTitle", { revision: pendingRestore ?? "" })}
        description={t("restoreBody")}
        confirmLabel={t("restore")}
        variant="default"
        onConfirm={() => {
          const revision = pendingRestore;
          setPendingRestore(null);
          if (revision !== null) void replaceDraft(revision);
        }}
      />
      <ConfirmDialog
        open={restoreMissing !== null}
        onOpenChange={(open) => { if (!open) setRestoreMissing(null); }}
        title={t("restoreMissingTitle", { revision: restoreMissing?.revision ?? "" })}
        description={t("restoreMissingBody", { count: restoreMissing?.images ?? 1 })}
        confirmLabel={t("restoreWithoutImages")}
        variant="default"
        onConfirm={() => {
          const missing = restoreMissing;
          setRestoreMissing(null);
          if (missing) void replaceDraft(missing.revision, true);
        }}
      />
      <ConfirmDialog
        open={pendingRemoveLanding !== null}
        onOpenChange={(open) => { if (!open) setPendingRemoveLanding(null); }}
        title={t("removeLandingTitle", { name: pendingRemoveLanding ? theme.pages.landing[pendingRemoveLanding]?.title ?? pendingRemoveLanding : "" })}
        description={t("removeLandingBody")}
        confirmLabel={t("removeLanding")}
        onConfirm={() => {
          const slug = pendingRemoveLanding;
          setPendingRemoveLanding(null);
          if (!slug) return;
          setDraft((current) => {
            const { [slug]: _removed, ...landing } = current.pages.landing;
            return { ...current, pages: { ...current.pages, landing } };
          });
          if (samePage(page, { kind: "landing", slug })) setPage({ kind: "home" });
        }}
      />
    </div>
  );
}

export function ThemeEditorPage() {
  const { data: workspace, refetch } = useSuspenseQuery(themeWorkspaceQueryOptions());
  return <ThemeEditor workspace={workspace} refetch={refetch} />;
}
