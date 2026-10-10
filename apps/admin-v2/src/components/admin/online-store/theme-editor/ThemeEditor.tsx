/**
 * The theme editor (Online store → Themes → Customize), built to the rules
 * in docs/research/BUILDER-UX-RESEARCH.md §4-§5:
 *
 * - a 48 px top bar: back, the theme's state and one autosave status, the
 *   page switcher, the previewed market and language, the device and the
 *   frame's size, undo, redo, history and Publish;
 * - a 320 px sidebar with the page's layers and Theme settings; below
 *   1600 px a selection's settings take the tree's place in the same
 *   column, from 1600 px they sit in a right column that is always there;
 *   below 1024 px the sidebar is a drawer, below 768 px a bottom sheet with
 *   a bottom bar;
 * - the real storefront at a true device width, scaled to fit, with hover
 *   and selection drawn above it. Nothing selected, hovered, saved or opened
 *   ever changes the frame's box, and edits show in it before they are
 *   saved (use-preview-sync.ts).
 */
import { PresenceSlot } from "~/lib/realtime/store";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Plus, Rows3, SlidersHorizontal } from "lucide-react";
import {
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_RENDERERS,
  failedFitConditions,
  isStorefrontAppSection,
  storefrontSectionBlockLists,
  storefrontSettingAt,
  type StorefrontPlatformSection,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { presencePath as presencePathOf } from "@scalius/shared/markets";
import { PLUGIN_HOME_SECTIONS_MAX } from "@scalius/shared/plugins/storefront";
import { cn } from "@scalius/shared/utils";
import { toast, useToastsAboveBar } from "~/lib/toast";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { typingIn } from "~/components/admin/layout/shortcuts";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { formatDateTime, getLocale, useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import type { NavigationResourceOption } from "~/lib/api-query-options/navigation";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { themeWorkspaceQueryOptions, type ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { languageName } from "../../translations/translation-form";
import { appSettingDefaults } from "../schema-form/app-settings";
import { useMediaPreviews, type MediaPreviews } from "../schema-form/media-previews";
import { settingErrors } from "../schema-form/errors";
import { useFitReason } from "../use-fit-reason";
import { appBlocksByKey, resolveThemeForStore, toggleProductModule } from "../theme-settings";
import { themeProblemTarget, type ThemeRevealRequest } from "../theme-reveal";
import { useOpenThemePreview } from "../theme-preview";
import type { AiPage } from "./AiDraftDialog";
import { DESKTOP_WIDTHS, type DesktopWidth, type FrameBox, type PreviewDevice, type PreviewZoom } from "./canvas-geometry";
import { EditorCanvas, type SelectionActions } from "./EditorCanvas";
import {
  EDITOR_PARTS,
  isResourcePage,
  moduleId,
  pageFixedPart,
  pageMain,
  pageSections,
  pageTemplate,
  previewPath,
  samePage,
  selectedModule,
  withPageSections,
  type EditorPage,
  type ResourcePageKind,
} from "./editor-pages";
import { parseBlockId, selectionMark } from "./editor-selection";
import {
  addBlock,
  addBlockedReason,
  appSectionsByKey,
  draftedSections,
  duplicateBlock,
  duplicateSection,
  fromPageItems,
  insertItem,
  mapSection,
  moveBlock,
  moveItem,
  newAppSection,
  newSection,
  pageItems,
  removeBlock,
  removeSection,
  toggleBlockHidden,
  unopenedAiSections,
  type PageItem,
} from "./editor-state";
import { EditorTopBar, MarketSwitcher, TopBarButton } from "./EditorTopBar";
import { ShortcutsDialog, matchesEditorShortcut } from "./EditorShortcuts";
import { LayerTree } from "./LayerTree";
import { CreateLandingDialog, PagePicker, PageStrip, PreviewResource, useDefaultResource, usePageName } from "./PagePicker";
import type { LibraryChoice, LibraryOption } from "./SectionLibrary";
import { SettingsEmpty, SettingsPane, partHasSettings, usePartTitle, type PaneActions } from "./SettingsPanel";
import { themeVersionDocumentQuery } from "./theme-history-queries";
import { useBlockName, useEditorTree, useSectionName } from "./use-editor-tree";
import { usePreview } from "./use-preview";
import { usePreviewSync } from "./use-preview-sync";
import { THEME_PRESENCE_KEY, useThemeDraft } from "./use-theme-draft";

type Theme = StorefrontThemeDocument;
type Section = StorefrontSection;

/**
 * What the first render does not need loads after it (research P13): the
 * selection's settings (the editor opens with nothing selected), Theme
 * settings, the library, publishing, history and Draft with AI. The panes
 * load on idle right after the first render, so they are there by the first
 * click; a dialog loads when it first opens.
 */
const loadPanes = () => import("./SelectionPanes");
const lazyNamed = <Props,>(load: () => Promise<ComponentType<Props>>) => lazy(async () => ({ default: await load() }));
const SectionPane = lazyNamed(() => loadPanes().then((module) => module.SectionPane));
const BlockPane = lazyNamed(() => loadPanes().then((module) => module.BlockPane));
const PartSettings = lazyNamed(() => loadPanes().then((module) => module.PartSettings as ComponentType<Parameters<typeof module.PartSettings>[0]>));
const AppSectionSettings = lazyNamed(() => loadPanes().then((module) => module.AppSectionSettings));
const ThemeSettingsPanel = lazyNamed(() => loadPanes().then((module) => module.ThemeSettingsPanel));
const SectionLibrary = lazyNamed(() => import("./SectionLibrary").then((module) => module.SectionLibrary));
const PublishDialog = lazyNamed(() => import("./PublishDialog").then((module) => module.PublishDialog));
const ThemeHistory = lazyNamed(() => import("./ThemeHistory").then((module) => module.ThemeHistory));
const AiDraftDialog = lazyNamed(() => import("./AiDraftDialog").then((module) => module.AiDraftDialog));

/** The first problem's data path in a platform section's settings ("slides.0.alt"), or null. */
function firstSettingError(section: StorefrontPlatformSection): string | null {
  return settingErrors(STOREFRONT_SECTION_REGISTRY[section.type].settings, section.settings).keys().next().value ?? null;
}

/** The phone's Layers / Theme / Add bar; toasts (removed, undo) sit above it, never over it. */
function PhoneBottomBar({ label, children }: { label: string; children: ReactNode }) {
  const bar = useRef<HTMLElement>(null);
  useToastsAboveBar(bar);
  return <nav ref={bar} aria-label={label} className="z-40 flex h-14 gap-1 border-t border-border bg-card px-2">{children}</nav>;
}

/** Puts the cursor in a field once the (lazy) pane draws it. */
function focusWhenShown(id: string) {
  let tries = 0;
  const attempt = () => {
    const field = document.getElementById(id);
    const target = field?.matches("input, textarea, button, select") ? field : field?.querySelector<HTMLElement>("input, textarea, button, select");
    if (target) {
      target.focus();
      target.scrollIntoView({ block: "center" });
    } else if (tries++ < 60) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** Per-browser view choices (research P3: the zoom is remembered). */
const VIEW_KEY = "scalius.themeEditor.view";
interface ViewChoices { zoom: PreviewZoom; desktopWidth: DesktopWidth; sidebar: boolean }
function readView(): ViewChoices {
  try {
    const value = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as Partial<ViewChoices> | null;
    return {
      zoom: value?.zoom === "actual" ? "actual" : "fit",
      desktopWidth: DESKTOP_WIDTHS.includes(value?.desktopWidth as DesktopWidth) ? value!.desktopWidth! : "fill",
      sidebar: value?.sidebar !== false,
    };
  } catch {
    return { zoom: "fit", desktopWidth: "fill", sidebar: true };
  }
}
function writeView(view: ViewChoices) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // A private window keeps the defaults.
  }
}

/** Sections with a setting to fix (what saves meanwhile is their saved value), for their rows. */
function useHeldSections(held: readonly string[]) {
  const t = useMessages(themeEditorMessages);
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const part of held) {
      if (part.startsWith("section:")) map.set(part.slice(part.lastIndexOf(":") + 1), t("sectionNeedsFix"));
    }
    return map;
  }, [held, t]);
}

export function ThemeEditor({ workspace, refetch }: {
  workspace: ThemeWorkspaceDocument;
  refetch: () => Promise<{ data?: ThemeWorkspaceDocument }>;
}) {
  const t = useMessages(themeEditorMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const canConnectAgent = useHasPermission(ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE);
  const media = useMediaPreviews(workspace.media);
  const appSections = useMemo(() => appSectionsByKey(workspace.apps), [workspace.apps]);
  const appBlocks = useMemo(() => appBlocksByKey(workspace.apps), [workspace.apps]);
  const draft = useThemeDraft({ workspace, refetch, canEdit, appSections, appBlocks });
  const theme = draft.working;
  const storeShape = workspace.storeShape;
  const resolved = useMemo(() => resolveThemeForStore(theme, storeShape as Parameters<typeof resolveThemeForStore>[1]), [theme, storeShape]);
  const sectionName = useSectionName(appSections);
  const blockName = useBlockName();
  const pageNameOf = usePageName();
  const partTitle = usePartTitle();
  const openPreviewTab = useOpenThemePreview();

  // ── Layout (research §5) ─────────────────────────────────────────────────
  const wide = useMediaQuery("(min-width: 1600px)");
  const desktop = useMediaQuery("(min-width: 1024px)");
  const phone = !useMediaQuery("(min-width: 768px)");
  const [view, setViewState] = useState<ViewChoices>(readView);
  const setView = (next: Partial<ViewChoices>) => setViewState((current) => {
    const value = { ...current, ...next };
    writeView(value);
    return value;
  });
  /** The panel slides only after a toggle the merchant made, never on load (P14). */
  const [animated, setAnimated] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheet, setSheet] = useState<"half" | "full">("half");
  const [deviceChoice, setDevice] = useState<PreviewDevice>("desktop");
  const device: PreviewDevice = phone ? "phone" : deviceChoice;
  const [inspector, setInspector] = useState(true);
  const [scale, setScale] = useState(1);
  const sidebarShown = desktop ? view.sidebar : drawerOpen;

  // ── Page, resource and market ────────────────────────────────────────────
  const [page, setPageState] = useState<EditorPage>({ kind: "home" });
  const [resources, setResources] = useState<Partial<Record<ResourcePageKind, NavigationResourceOption>>>({});
  const resourceKind = isResourcePage(page) ? page.kind : null;
  const defaults = useDefaultResource(resourceKind);
  const resource = resourceKind ? resources[resourceKind] ?? defaults.resource : null;
  const markets = useQuery(marketsQueryOptions());
  const marketOptions = useMemo(() => (markets.data ?? [])
    .filter((market) => market.status === "active" && market.presence)
    .map((market) => {
      const presence = market.presence!;
      const country = market.countries[0] ?? "";
      return {
        value: presence.value,
        locale: presence.locale,
        short: `${country}${country ? " · " : ""}${presence.locale.toUpperCase()}`,
        label: `${market.name} · ${languageName(presence.locale, getLocale())}`,
        backup: market.isBackup,
      };
    }), [markets.data]);
  const [presence, setPresence] = useState("");
  const defaultLocale = marketOptions.find((option) => option.backup)?.locale ?? null;
  const previewLocale = marketOptions.find((option) => option.value === presence)?.locale ?? defaultLocale;
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const versionDocument = useQuery(themeVersionDocumentQuery(page.kind === "landing" ? previewRevision : null));
  const versionLacksPage = page.kind === "landing" && previewRevision !== null && versionDocument.data !== undefined && !versionDocument.data.pages.landing[page.slug];
  const basePath = versionLacksPage ? "/" : previewPath(page, resource?.url ?? null);
  const path = basePath === null ? null : presencePathOf(presence || null, basePath);

  // ── Selection ────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<"sections" | "theme">("sections");
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const sections = pageSections(theme, page);
  const main = pageMain(theme, page);
  const items = useMemo(() => (sections ? pageItems(sections, main) : []), [sections, main]);
  const block = parseBlockId(selected);
  const selectedSection = sections?.find((section) => section.id === (block?.sectionId ?? selected)) ?? null;

  const setPage = (next: EditorPage) => {
    setPageState(next);
    setSelected(null);
    setTab("sections");
  };
  // A landing page undone or restored away: back to the homepage.
  useEffect(() => {
    if (page.kind === "landing" && !theme.pages.landing[page.slug]) setPage({ kind: "home" });
  }, [page, theme.pages.landing]); // eslint-disable-line react-hooks/exhaustive-deps -- setPage is stable in effect
  // A selection that is gone (undo, a removal elsewhere) is dropped.
  useEffect(() => {
    if (!selected) return;
    const sectionId = block?.sectionId ?? selected;
    const isSection = sections?.some((section) => section.id === sectionId);
    const isPart = Object.values(EDITOR_PARTS).includes(selected as never) || selectedModule(selected) !== null;
    if (!isSection && !isPart) setSelected(null);
    if (block && selectedSection && block.index >= ((storefrontSettingAt(selectedSection.settings, block.path) as unknown[] | undefined)?.length ?? 0)) setSelected(block.sectionId);
  }, [theme, selected]); // eslint-disable-line react-hooks/exhaustive-deps -- re-checked per document

  // ── Preview ──────────────────────────────────────────────────────────────
  const [connectedAt, setConnectedAt] = useState(0);
  const [revealErrors, setRevealErrors] = useState(false);
  const [themeReveal, setThemeReveal] = useState<ThemeRevealRequest | null>(null);
  const select = useCallback((id: string | null, from: "tree" | "preview" | "other" = "other") => {
    setSelected(id);
    setRevealErrors(false);
    setThemeReveal(null);
    if (!id) return;
    setTab("sections");
    const sectionId = parseBlockId(id)?.sectionId ?? id;
    if (sections?.find((section) => section.id === sectionId)?.aiDraft) draft.dispatch({ type: "opened", id: sectionId });
    if (!desktop) {
      setDrawerOpen(true);
      if (from === "preview") setSheet("half");
    }
  }, [sections, draft, desktop]);
  const preview = usePreview({
    draftRevision: draft.saved.revision,
    sourceRevision: previewRevision,
    path: draft.saved.revision > 0 ? path : null,
    inspector,
    onSelect: (id) => select(id, "preview"),
    onKey: (press) => handleKey(press, null),
    onConnected: () => setConnectedAt((count) => count + 1),
  });
  usePreviewSync({
    send: preview.send,
    reload: preview.reload,
    connectedAt,
    working: theme,
    sendable: previewRevision === null ? draft.pending : null,
    savedTheme: draft.saved.theme,
    page,
    presence: presence || null,
    marks: preview.marks,
    onNeedSave: draft.saveSoon,
  });
  // Selecting from the tree brings the part into view only when it is outside it (P8).
  const mark = selectionMark(selected);
  useEffect(() => {
    if (mark) preview.send({ type: "reveal", id: mark });
  }, [mark]); // eslint-disable-line react-hooks/exhaustive-deps -- once per selection

  // ── Edits ────────────────────────────────────────────────────────────────
  const { setDraft } = draft;
  const editItems = useCallback((update: (items: PageItem[]) => PageItem[]) => setDraft((current) => {
    const now = pageSections(current, page);
    if (!now) return current;
    const next = fromPageItems(update(pageItems(now, pageMain(current, page))));
    return withPageSections(current, page, next.sections, next.main ?? undefined);
  }), [setDraft, page]);
  const editSection = (id: string, update: (section: Section) => Section) => editItems((current) => mapSection(current, id, update));

  const remove = (id: string) => {
    const result = removeSection(items, id);
    if (!result) return;
    editItems(() => result.items);
    if (selectionMark(selected) === id) setSelected(null);
    toast.success(t("removed"), {
      duration: 10_000,
      action: { label: t("undoRemove"), onClick: () => editItems((current) => current.some((item) => item.kind === "section" && item.section.id === id) ? current : insertItem(current, result.removed, result.index)) },
    });
  };
  const duplicate = (id: string) => {
    const result = duplicateSection(items, id);
    if (result) {
      editItems(() => result.items);
      select(result.id);
    } else toast.error(t("cannotDuplicate"));
  };
  const toggle = (id: string) => editSection(id, (section) => ({ ...section, hidden: !section.hidden }));
  const moveSelected = (delta: -1 | 1) => {
    const id = selectionMark(selected);
    const from = items.findIndex((item) => (item.kind === "section" ? item.section.id : pageFixedPart(page)) === id);
    if (from >= 0) editItems((current) => moveItem(current, from, from + delta));
  };

  const handlers = {
    toggleSection: toggle,
    duplicateSection: duplicate,
    removeSection: remove,
    addSectionAt: (index: number) => setLibraryAt(index),
    toggleBlock: (sectionId: string, path: string, index: number) => editSection(sectionId, (section) => toggleBlockHidden(section, path, index)),
    duplicateBlock: (sectionId: string, path: string, index: number) => editSection(sectionId, (section) => duplicateBlock(section, path, index) ?? section),
    removeBlock: (sectionId: string, path: string, index: number) => {
      editSection(sectionId, (section) => removeBlock(section, path, index));
      setSelected(sectionId);
    },
    addBlock: (sectionId: string, path: string) => {
      const section = sections?.find((each) => each.id === sectionId);
      if (!section) return;
      // A hero's slides come from Files: its settings offer that.
      if (section.type === "hero" && path === "slides") {
        select(sectionId, "tree");
        return;
      }
      const next = addBlock(section, path);
      if (!next) return;
      editSection(sectionId, () => next);
      select(`${sectionId}/${path}/${(storefrontSettingAt(next.settings, path) as unknown[]).length - 1}`, "tree");
    },
    toggleModule: (module: Parameters<typeof toggleProductModule>[1]) => setDraft((current) => ({
      ...current,
      blocks: { ...current.blocks, product: { ...current.blocks.product, below: toggleProductModule(current.blocks.product.below, module, !current.blocks.product.below.includes(module)) } },
    })),
  };
  const onTreeMove = (list: string, from: number, to: number) => {
    if (list === "page") editItems((current) => moveItem(current, from, to));
    else if (list === "modules") setDraft((current) => ({ ...current, blocks: { ...current.blocks, product: { ...current.blocks.product, below: moveItem(current.blocks.product.below, from, to) } } }));
    else if (list.startsWith("blocks:")) {
      const [, sectionId, path] = list.split(":");
      editSection(sectionId!, (section) => moveBlock(section, path!, from, to));
    }
  };

  // ── Library and AI ───────────────────────────────────────────────────────
  const [libraryAt, setLibraryAt] = useState<number | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  // Always offered to editors: without an AI app or agent, the dialog says what to turn on.
  const aiAvailable = canEdit;
  const template = pageTemplate(page);
  const fitReason = useFitReason(resolved.facts);
  const libraryOptions: LibraryOption[] = useMemo(() => {
    const current = sections ?? [];
    const reason = (blocked: ReturnType<typeof addBlockedReason>) => blocked === "limit" ? t("sectionLimit", { count: 24 })
      : blocked === "one-hero" ? t("onePerPage")
        : blocked === "app-limit" ? t("appSectionLimit", { count: PLUGIN_HOME_SECTIONS_MAX })
          : null;
    return [
      ...STOREFRONT_SECTION_RENDERERS.map((type) => {
        const failed = failedFitConditions(STOREFRONT_SECTION_REGISTRY[type].requires, { facts: resolved.facts, blocks: {} });
        const deliveryOnly = type === "usp-strip" && (template === "collection" || template === "page");
        return {
          choice: { type } as LibraryChoice,
          blocked: reason(addBlockedReason(current, type)),
          note: deliveryOnly ? t("deliveryFactsNote") : failed.length > 0 ? fitReason({ failed }) : undefined,
        };
      }),
      ...workspace.apps.flatMap((app) => app.sections.map((section) => ({ choice: { app: section.key } as LibraryChoice, blocked: reason(addBlockedReason(current, "app")) }))),
    ];
  }, [sections, resolved.facts, workspace.apps, template, t, fitReason]);
  const addFromLibrary = (choice: LibraryChoice) => {
    const current = sections ?? [];
    const section = "type" in choice
      ? newSection(choice.type, current)
      : newAppSection(choice.app, appSettingDefaults(appSections.get(choice.app)?.section.settings ?? []), current);
    const at = libraryAt ?? items.length;
    editItems((now) => insertItem(now, section, at));
    setLibraryAt(null);
    select(section.id, "other");
  };
  const aiPage: AiPage = page.kind === "category" || page.kind === "search" ? "collection" : page.kind;
  const onDrafted = (drafted: Section[], note: string | null, rejected: number) => {
    const added = draftedSections(drafted, sections ?? []);
    const at = libraryAt ?? items.length;
    editItems((now) => added.reduce((list, section, offset) => insertItem(list, section, at + offset), now));
    setAiOpen(false);
    setLibraryAt(null);
    toast.success(added.length === 1 ? t("aiDraftedOne") : t("aiDrafted", { count: added.length }), {
      description: [note, rejected === 1 ? t("aiRejectedOne") : rejected > 1 ? t("aiRejected", { count: rejected }) : null].filter(Boolean).join(" ") || undefined,
    });
    if (added[0]) setSelected(null);
  };

  // ── Dialogs ──────────────────────────────────────────────────────────────
  const [publishOpen, setPublishOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const libraryMounted = useOpenedOnce(libraryAt !== null);
  const publishMounted = useOpenedOnce(publishOpen);
  const historyMounted = useOpenedOnce(historyOpen);
  // The settings panes load right after the first render (nothing is selected yet).
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((task: () => void) => window.setTimeout(task, 200));
    idle(() => void loadPanes());
  }, []);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [creatingLanding, setCreatingLanding] = useState(false);
  const [removingLanding, setRemovingLanding] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{ version: number } | { point: string } | null>(null);
  const [restoreMissing, setRestoreMissing] = useState<{ source: { version: number } | { point: string }; images: number } | null>(null);
  const restore = async (source: { version: number } | { point: string }, withoutMissing = false) => {
    setSelected(null);
    setPreviewRevision(null);
    const missing = await draft.replaceDraft(source, withoutMissing);
    if (missing) setRestoreMissing({ source, images: missing.missingImages });
    else preview.reload();
  };

  /**
   * "1 setting to fix": opens the first part that is held back, on its page,
   * at the block that holds the problem, and puts the cursor in the field.
   */
  const showProblem = () => {
    const part = draft.held[0];
    if (!part) return;
    if (!part.startsWith("section:")) {
      const target = themeProblemTarget(theme, part);
      if (target.kind === "part") {
        if (target.part === "page" && page.kind !== "home") setPageState({ kind: "home" });
        select(target.part === "announcement" ? EDITOR_PARTS.announcement : EDITOR_PARTS.page, "tree");
        setRevealErrors(true);
      } else {
        setSelected(null);
        setTab("theme");
        if (!desktop) setDrawerOpen(true);
        if (target.kind === "group") setThemeReveal({ group: target.group, nonce: Date.now() });
      }
      if (target.kind !== "theme" && target.fieldId) focusWhenShown(target.fieldId);
      return;
    }
    const rest = part.slice("section:".length);
    const sectionId = rest.slice(rest.lastIndexOf(":") + 1);
    const list = rest.slice(0, rest.lastIndexOf(":"));
    const where: EditorPage = list === "home" ? { kind: "home" }
      : list.startsWith("landing:") ? { kind: "landing", slug: list.slice("landing:".length) }
        : { kind: list.slice("template:".length) as "product" | "collection" | "cart" | "page" };
    const section = pageSections(theme, where)?.find((each) => each.id === sectionId);
    if (!section) return;
    if (!samePage(where, page)) setPageState(where);
    const path = isStorefrontAppSection(section) ? null : firstSettingError(section);
    const inBlock = path ? storefrontSectionBlockLists(section.type).find((each) => path.startsWith(`${each.path}.`)) : undefined;
    const index = inBlock && path ? Number(path.slice(inBlock.path.length + 1).split(".")[0]) : -1;
    select(inBlock && index >= 0 ? `${section.id}/${inBlock.path}/${index}` : section.id, "tree");
    setRevealErrors(true);
    // The settings forms' field ids (SectionSettings, SchemaSettingsForm): `theme-section-<id>-<path with dashes>`.
    if (path) focusWhenShown(`theme-section-${section.id}-${path.replace(/\./g, "-")}`);
  };

  // ── Keyboard (research P18) ──────────────────────────────────────────────
  const handleKey = (press: { key: string; mod: boolean; shift: boolean; alt: boolean }, event: KeyboardEvent | null) => {
    const handled = () => event?.preventDefault();
    if (matchesEditorShortcut("undo", press)) { handled(); draft.dispatch({ type: "undo" }); }
    else if (matchesEditorShortcut("redo", press)) { handled(); draft.dispatch({ type: "redo" }); }
    else if (matchesEditorShortcut("save", press)) { handled(); void draft.save(); }
    else if (matchesEditorShortcut("shortcuts", press)) { handled(); setShortcutsOpen(true); }
    else if (matchesEditorShortcut("sidebar", press)) { handled(); toggleSidebar(); }
    else if (matchesEditorShortcut("back", press)) { if (selected) { handled(); setSelected(block ? block.sectionId : null); } }
    else if (matchesEditorShortcut("previous", press) || matchesEditorShortcut("next", press)) {
      handled();
      const ids = items.map((item) => (item.kind === "section" ? item.section.id : pageFixedPart(page)!));
      const at = ids.indexOf(selectionMark(selected) ?? "");
      const next = ids[matchesEditorShortcut("previous", press) ? Math.max(0, at - 1) : Math.min(ids.length - 1, at + 1)];
      if (next) select(next, "tree");
    } else if (canEdit && selectedSection && block === null) {
      if (matchesEditorShortcut("duplicate", press)) { handled(); duplicate(selectedSection.id); }
      else if (matchesEditorShortcut("hide", press)) { handled(); toggle(selectedSection.id); }
      else if (matchesEditorShortcut("remove", press)) { handled(); remove(selectedSection.id); }
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typingIn(event.target)) return;
      // The tree's own keys stay the tree's.
      if ((event.target as HTMLElement | null)?.closest?.("[role=tree]") && !event.metaKey && !event.ctrlKey && event.key !== "\\") return;
      handleKey({ key: event.key, mod: event.metaKey || event.ctrlKey, shift: event.shiftKey, alt: event.altKey }, event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function toggleSidebar() {
    setAnimated(true);
    if (desktop) setView({ sidebar: !view.sidebar });
    else setDrawerOpen((open) => !open);
  }

  // ── The tree, the selection's settings and the canvas' chrome ───────────
  const pageName = pageNameOf(page, theme);
  const heldSections = useHeldSections(draft.held);
  const groups = useEditorTree({ theme, page, pageName, resolved, appSections, heldSections, readOnly: !canEdit, handlers });
  const expandTo = block ? [block.sectionId] : selectedModule(selected) ? [EDITOR_PARTS.productMain] : selected === EDITOR_PARTS.listingToolbar || selected === EDITOR_PARTS.listingFilters ? [EDITOR_PARTS.listing] : [];

  const names = useMemo(() => {
    const entries: Record<string, { name: string; shared?: boolean }> = {
      [EDITOR_PARTS.announcement]: { name: t("announcement"), shared: true },
      [EDITOR_PARTS.header]: { name: t("headerRow"), shared: true },
      [EDITOR_PARTS.footer]: { name: t("footerRow"), shared: true },
    };
    for (const section of sections ?? []) entries[section.id] = { name: sectionName(section) };
    const fixed = pageFixedPart(page);
    if (fixed) entries[fixed] = { name: partTitle(fixed, page) ?? "" };
    for (const module of theme.blocks.product.below) entries[moduleId(module)] = { name: t(`module_${module}`) };
    entries[EDITOR_PARTS.productApps] = { name: t("appBlocks") };
    entries[EDITOR_PARTS.listingFilters] = { name: t("listingFilters") };
    return entries;
  }, [sections, page, theme.blocks.product.below, sectionName, partTitle, t]);

  const sectionIndex = items.findIndex((item) => item.kind === "section" && item.section.id === selectionMark(selected));
  const fixedIndex = items.findIndex((item) => item.kind === "fixed");
  const canvasActions: SelectionActions | null = (() => {
    const markId = selectionMark(selected);
    if (!markId) return null;
    const shared = markId === EDITOR_PARTS.header || markId === EDITOR_PARTS.footer || markId === EDITOR_PARTS.announcement;
    const name = names[markId]?.name ?? "";
    if (!canEdit || previewRevision !== null) return { name, shared };
    if (sectionIndex >= 0) {
      const section = (items[sectionIndex] as { section: Section }).section;
      return {
        name,
        canMoveUp: sectionIndex > 0,
        canMoveDown: sectionIndex < items.length - 1,
        onMoveUp: () => moveSelected(-1),
        onMoveDown: () => moveSelected(1),
        onDuplicate: () => duplicate(section.id),
        hidden: section.hidden === true,
        onToggleHidden: () => toggle(section.id),
        onRemove: () => remove(section.id),
        onAddAbove: () => setLibraryAt(sectionIndex),
        onAddBelow: () => setLibraryAt(sectionIndex + 1),
      };
    }
    if (markId === pageFixedPart(page) && fixedIndex >= 0 && items.length > 1) {
      return { name, canMoveUp: fixedIndex > 0, canMoveDown: fixedIndex < items.length - 1, onMoveUp: () => moveSelected(-1), onMoveDown: () => moveSelected(1) };
    }
    return { name, shared };
  })();

  const sharedSelected = selected === EDITOR_PARTS.header || selected === EDITOR_PARTS.footer || selected === EDITOR_PARTS.announcement;
  // A shared part is on every page: its place is "All pages", not the page being previewed.
  const crumbs = [sharedSelected ? t("allPages") : pageName, ...(block && selectedSection ? [sectionName(selectedSection)] : [])];
  const paneTitle = !selected ? ""
    : block && selectedSection ? blockName(selectedSection, block.path, block.index, (storefrontSettingAt(selectedSection.settings, block.path) as unknown[] | undefined)?.[block.index])
      : selectedSection ? sectionName(selectedSection)
        : partTitle(selected, page) ?? "";
  const translatable = previewLocale !== null && defaultLocale !== null && previewLocale !== defaultLocale && (selectedSection !== null || sharedSelected);
  const notices: ReactNode = (
    <>
      {sharedSelected ? <Alert variant="info"><AlertDescription>{t("sharedNotice")}</AlertDescription></Alert> : null}
      {translatable ? (
        <Alert variant="info">
          <AlertDescription>
            {t("translationNotice", { language: languageName(defaultLocale!, getLocale()) })}{" "}
            <a href="/admin/settings/languages" className="text-link underline">{t("manageLanguages")}</a>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
  let paneContent: ReactNode = null;
  let paneActions: PaneActions | undefined;
  if (selectedSection && block && !isStorefrontAppSection(selectedSection)) {
    const list = (storefrontSettingAt(selectedSection.settings, block.path) as unknown[] | undefined) ?? [];
    const item = list[block.index] as { hidden?: boolean } | undefined;
    paneContent = (
      <BlockPane
        section={selectedSection}
        path={block.path}
        index={block.index}
        media={media}
        reveal={revealErrors}
        onChange={(settings) => editSection(selectedSection.id, (section) => ({ ...section, settings } as Section))}
      />
    );
    paneActions = {
      hidden: item?.hidden === true,
      onToggleHidden: () => handlers.toggleBlock(selectedSection.id, block.path, block.index),
      onDuplicate: () => handlers.duplicateBlock(selectedSection.id, block.path, block.index),
      onRemove: () => handlers.removeBlock(selectedSection.id, block.path, block.index),
    };
  } else if (selectedSection) {
    paneContent = isStorefrontAppSection(selectedSection) ? (
      <AppSectionSettings
        key={selectedSection.id}
        section={selectedSection}
        entry={appSections.get(selectedSection.settings.app)}
        onChange={(values) => editSection(selectedSection.id, (section) => (section.type === "app" ? { ...section, settings: { ...section.settings, values } } : section))}
      />
    ) : (
      <SectionPane
        section={selectedSection}
        media={media}
        canEdit={canEdit}
        reveal={revealErrors}
        onSelectBlock={(id) => select(id, "tree")}
        onChange={(settings) => editSection(selectedSection.id, (section) => ({ ...section, settings } as Section))}
      />
    );
    paneActions = {
      hidden: selectedSection.hidden === true,
      onToggleHidden: () => toggle(selectedSection.id),
      onDuplicate: () => duplicate(selectedSection.id),
      onRemove: () => remove(selectedSection.id),
    };
  } else if (selected && partHasSettings(selected, page)) {
    paneContent = (
      <PartSettings
        selected={selected}
        page={page}
        theme={theme}
        resolved={resolved}
        media={media}
        apps={workspace.apps}
        cmsPageId={page.kind === "page" ? resource?.id ?? null : null}
        setDraft={setDraft}
        onRemoveLanding={setRemovingLanding}
      />
    );
  }
  const pane = selected && paneContent !== null ? (
    <SettingsPane
      title={paneTitle}
      crumbs={crumbs}
      notices={notices}
      onBack={() => setSelected(wide || !block ? null : block.sectionId)}
      closes={wide}
      actions={paneActions}
      readOnly={!canEdit}
    >
      <Suspense fallback={null}>{paneContent}</Suspense>
    </SettingsPane>
  ) : null;

  const tree = (
    <div className="flex h-full min-h-0 flex-col">
      {resourceKind ? (
        <PreviewResource
          kind={resourceKind}
          resource={resource}
          loading={defaults.loading}
          failed={defaults.failed}
          onChange={(next) => setResources((current) => ({ ...current, [resourceKind]: next }))}
        />
      ) : (
        <PageStrip text={page.kind === "landing" ? t("landingSlugHelp", { path: `/pages/${page.slug}` }) : t(`pageHint_${page.kind}`)} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
        <LayerTree groups={groups} selected={selected} onSelect={(id) => select(id, "tree")} onHover={(id) => setHovered(id)} onMove={onTreeMove} expandTo={expandTo} />
      </div>
    </div>
  );

  const sidebar = (
    <Tabs value={tab} onValueChange={(value) => setTab(value as "sections" | "theme")} className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <TabsList className="w-full">
          <TabsTrigger value="sections" className="flex-1">{t("tabSections")}</TabsTrigger>
          <TabsTrigger value="theme" className="flex-1">{t("tabTheme")}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="sections" className="mt-0 min-h-0 flex-1">{tree}</TabsContent>
      <TabsContent value="theme" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        <fieldset disabled={!canEdit} className="min-w-0">
          <Suspense fallback={null}>
            <ThemeSettingsPanel theme={theme} resolved={resolved} media={media} setDraft={setDraft} reveal={themeReveal} />
          </Suspense>
        </fieldset>
      </TabsContent>
    </Tabs>
  );

  // Hover from the tree outlines the part in the preview; the preview's own hover too.
  const outlined = hovered ? selectionMark(hovered) : preview.hovered;
  const conflictNotice = draft.conflict ? (
    <Alert variant="warning">
      <AlertDescription>
        {draft.conflict.name
          ? t("conflictNamed", { name: draft.conflict.name, time: draft.conflict.at ? formatDateTime(new Date(draft.conflict.at), { timeStyle: "short" }) : "" })
          : t("statusConflict")}
        <span className="mt-2 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" loading={draft.busy} onClick={() => void draft.reload()}>{t("reloadDraft")}</Button>
          <Button type="button" variant="outline" size="sm" disabled={draft.busy} onClick={() => void draft.reload(true)}>{t("overwriteDraft")}</Button>
        </span>
      </AlertDescription>
    </Alert>
  ) : draft.failureMessage ? (
    <Alert variant="warning">
      <AlertDescription>
        {t("saveFailed", { reason: draft.failureMessage })}
        <span className="mt-2 flex"><Button type="button" variant="outline" size="sm" onClick={() => void draft.save()}>{t("retry")}</Button></span>
      </AlertDescription>
    </Alert>
  ) : previewRevision !== null ? (
    <Alert variant="info">
      <AlertDescription>
        {t(versionLacksPage ? "previewingVersionHome" : "previewingVersion", { revision: previewRevision })}
        <span className="mt-2 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setPreviewRevision(null)}>{t("currentDraft")}</Button>
          {previewRevision !== draft.published.revision && canEdit ? (
            <Button type="button" size="sm" disabled={draft.busy} onClick={() => setPendingRestore({ version: previewRevision })}>{t("restore")}</Button>
          ) : null}
        </span>
      </AlertDescription>
    </Alert>
  ) : preview.shownPath && path && preview.phase === "ready" && !preview.loading && preview.shownPath !== path.split("?")[0] ? (
    <Alert variant="info">
      <AlertDescription>
        {t("viewingPath", { path: preview.shownPath })}
        <span className="mt-2 flex"><Button type="button" variant="outline" size="sm" onClick={preview.reload}>{t("backToPage", { page: pageName })}</Button></span>
      </AlertDescription>
    </Alert>
  ) : null;

  const unopened = useMemo(() => unopenedAiSections(theme), [theme]);
  const publishable = canEdit && draft.differsFromLive && !draft.conflict && !draft.busy && draft.pending !== null;

  return (
    <div className="grid h-svh grid-rows-[auto_minmax(0,1fr)_auto] bg-background text-foreground" data-theme-editor>
      <h1 className="sr-only">{t("title")}</h1>
      <EditorTopBar
        status={draft.status}
        heldCount={Math.max(1, draft.held.length)}
        onShowProblem={showProblem}
        onRetry={() => void draft.save()}
        live={!draft.differsFromLive}
        canEdit={canEdit}
        sidebarOpen={sidebarShown}
        onToggleSidebar={toggleSidebar}
        pagePicker={(
          <PagePicker
            theme={theme}
            page={page}
            onPage={setPage}
            onCreate={canEdit ? () => setCreatingLanding(true) : undefined}
            className={phone ? "w-full" : "w-44"}
          />
        )}
        market={(
          <>
            {phone ? null : (
              <div data-slot="presence" className="flex h-7 shrink-0 items-center">
                <PresenceSlot
                  presenceKey={THEME_PRESENCE_KEY}
                  revision={draft.saved.revision}
                  dirty={draft.unsavedEdits}
                  notices={false}
                  // Another person's save loads at once while this editor has nothing unsaved (with
                  // unsaved edits, the next autosave meets their revision and the conflict names them).
                  onRemoteSave={() => {
                    if (!draft.unsavedEdits && !draft.busy) void draft.reload(false);
                  }}
                />
              </div>
            )}
            <MarketSwitcher options={marketOptions} value={presence} onChange={setPresence} />
          </>
        )}
        device={device}
        onDevice={(next) => setDevice(next)}
        desktopWidth={view.desktopWidth}
        onDesktopWidth={(desktopWidth) => setView({ desktopWidth })}
        zoom={view.zoom}
        onZoom={(zoom) => setView({ zoom })}
        scale={scale}
        inspector={inspector}
        onInspector={setInspector}
        canUndo={draft.history.past.length > 0}
        canRedo={draft.history.future.length > 0}
        onUndo={() => draft.dispatch({ type: "undo" })}
        onRedo={() => draft.dispatch({ type: "redo" })}
        onHistory={() => setHistoryOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onDraftWithAi={aiAvailable ? () => setAiOpen(true) : null}
        draftHere={sections !== null}
        onOpenPreview={path && draft.saved.revision > 0 ? () => {
          void openPreviewTab(draft.saved.revision, path, "full", previewRevision ?? undefined).then((result) => {
            // A blocked pop-up or a failed hand-over says so (it never does nothing).
            if (result !== "opened") toast.error(t(result === "path" ? "previewTabPath" : "previewTabFailed"));
          });
        } : null}
        canDiscard={canEdit && draft.differsFromLive && !draft.busy}
        onDiscard={() => setConfirmDiscard(true)}
        canPublish={publishable}
        publishing={draft.publishing}
        onPublish={() => setPublishOpen(true)}
        phone={phone}
      />

      <div
        className={cn(
          "relative grid min-h-0 min-w-0",
          desktop ? (wide ? "grid-cols-[auto_minmax(0,1fr)_320px]" : "grid-cols-[auto_minmax(0,1fr)]") : "grid-cols-1",
        )}
      >
        {desktop ? (
          <aside
            aria-label={t("sidebar")}
            inert={draft.busy || !view.sidebar}
            className={cn(
              "relative min-h-0 overflow-hidden border-e border-border bg-card",
              view.sidebar ? "w-80" : "w-0 border-e-0",
              animated && "transition-[width] duration-200 motion-reduce:transition-none",
            )}
          >
            <div className="absolute inset-y-0 start-0 w-80">
              {/* Under an open settings pane the tree is out of reach (Tab and screen readers too). */}
              <div inert={!wide && pane !== null} className="h-full">{sidebar}</div>
              {!wide ? (
                <div inert={!pane} className={cn("absolute inset-0 bg-card", !pane && "invisible")}>
                  {pane}
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}

        <EditorCanvas
          device={device}
          desktopWidth={view.desktopWidth}
          zoom={phone ? "fit" : view.zoom}
          phase={preview.phase}
          frames={preview.frames}
          activeId={preview.activeId}
          register={preview.register}
          layout={preview.layout}
          hovered={inspector ? outlined : null}
          selected={selectionMark(selected)}
          names={names}
          actions={canvasActions}
          notice={conflictNotice}
          behind={preview.behind}
          onRetry={preview.retry}
          onScaleChange={(box: FrameBox) => setScale(box.scale)}
        />

        {wide ? (
          <aside aria-label={t("settingsColumn")} inert={draft.busy} className="min-h-0 border-s border-border bg-card">
            {pane ?? <SettingsEmpty />}
          </aside>
        ) : null}

        {!desktop ? (
          <aside
            aria-label={t("sidebar")}
            inert={!drawerOpen}
            className={cn(
              "fixed z-30 flex flex-col bg-card shadow-modal",
              phone
                ? cn("inset-x-0 bottom-14 rounded-t-2xl", sheet === "full" ? "top-16" : "h-[48dvh]", !drawerOpen && "invisible translate-y-full")
                : cn("inset-y-12 start-0 w-80", !drawerOpen && "invisible -translate-x-full rtl:translate-x-full"),
              "transition-transform duration-200 motion-reduce:transition-none",
            )}
          >
            {phone ? (
              <button
                type="button"
                aria-label={t(sheet === "full" ? "sheetHalf" : "sheetFull")}
                onClick={() => setSheet((current) => (current === "full" ? "half" : "full"))}
                className="flex h-5 w-full shrink-0 items-center justify-center rounded-t-2xl"
              >
                <span className="h-1 w-9 rounded-full bg-border" aria-hidden="true" />
              </button>
            ) : null}
            <div className="relative min-h-0 flex-1">
              {pane ?? sidebar}
            </div>
          </aside>
        ) : null}
      </div>

      {phone ? (
        <PhoneBottomBar label={t("editorBar")}>
          {([
            ["layers", Rows3, () => { setTab("sections"); setSelected(null); setDrawerOpen((open) => !(open && tab === "sections" && !selected)); }],
            ["theme", SlidersHorizontal, () => { setTab("theme"); setSelected(null); setDrawerOpen((open) => !(open && tab === "theme")); }],
            ["add", Plus, () => setLibraryAt(items.length)],
          ] as const).map(([key, Icon, onClick]) => (
            <TopBarButton key={key} label={t(`bar_${key}`)} tip={false} onClick={onClick} disabled={key === "add" && (!sections || !canEdit)} className="flex h-auto w-auto flex-1 flex-col gap-0.5 text-foreground hover:bg-accent">
              <Icon aria-hidden="true" />
              <span className="text-caption">{t(`bar_${key}`)}</span>
            </TopBarButton>
          ))}
        </PhoneBottomBar>
      ) : <span />}

      <UnsavedChangesGuard isDirty={draft.unsavedEdits} isSubmitting={false} />
      {libraryMounted ? (
        <Suspense fallback={null}>
          <SectionLibrary
            open={libraryAt !== null}
            onOpenChange={(open) => { if (!open) setLibraryAt(null); }}
            theme={theme}
            options={libraryOptions}
            apps={workspace.apps}
            aiAvailable={aiAvailable}
            onAdd={addFromLibrary}
            onDraftWithAi={() => setAiOpen(true)}
          />
        </Suspense>
      ) : null}
      {aiOpen ? (
        <Suspense fallback={null}>
          <AiDraftDialog
            open={aiOpen}
            onOpenChange={setAiOpen}
            page={aiPage}
            locale={previewLocale ?? "en"}
            canConnectAgent={canConnectAgent}
            onDrafted={onDrafted}
          />
        </Suspense>
      ) : null}
      {publishMounted ? (
        <Suspense fallback={null}>
          <PublishDialog
            open={publishOpen}
            onOpenChange={setPublishOpen}
            live={draft.published.theme}
            draft={draft.pending ?? draft.saved.theme}
            unopenedAi={unopened}
            sectionName={sectionName}
            publishing={draft.publishing}
            onOpenSection={(id) => {
              setPublishOpen(false);
              const at = (Object.entries(theme.pages.landing).find(([, landing]) => landing.sections.some((section) => section.id === id))?.[0]);
              const where: EditorPage = theme.pages.home.some((section) => section.id === id) ? { kind: "home" }
                : at ? { kind: "landing", slug: at }
                  : (["product", "collection", "cart", "page"] as const).map((kind) => ({ kind })).find(({ kind }) => theme.pages.templates[kind].sections.some((section) => section.id === id)) ?? page;
              if (!samePage(where, page)) setPageState(where);
              select(id);
            }}
            onPublish={(note) => void draft.publish(note).then((done) => { if (done) setPublishOpen(false); })}
          />
        </Suspense>
      ) : null}
      {historyMounted ? (
        <Suspense fallback={null}>
          <ThemeHistory
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            draft={theme}
            liveRevision={draft.published.revision}
            previewRevision={previewRevision}
            busy={draft.busy || !canEdit}
            sectionName={sectionName}
            onPreview={(revision) => {
              setPreviewRevision(revision);
              setHistoryOpen(false);
            }}
            onRestore={(revision) => setPendingRestore({ version: revision })}
            onRestorePoint={(id) => setPendingRestore({ point: id })}
          />
        </Suspense>
      ) : null}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t("discardTitle")}
        description={t("discardBody")}
        confirmLabel={t("discard")}
        onConfirm={() => {
          setConfirmDiscard(false);
          setSelected(null);
          void draft.replaceDraft(null).then(() => preview.reload());
        }}
      />
      <ConfirmDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => { if (!open) setPendingRestore(null); }}
        title={pendingRestore && "version" in pendingRestore ? t("restoreTitle", { revision: pendingRestore.version }) : t("restorePointTitle")}
        description={t("restoreBody")}
        confirmLabel={t("restore")}
        variant="default"
        onConfirm={() => {
          const source = pendingRestore;
          setPendingRestore(null);
          if (source) void restore(source);
        }}
      />
      <ConfirmDialog
        open={restoreMissing !== null}
        onOpenChange={(open) => { if (!open) setRestoreMissing(null); }}
        title={t("restoreMissingTitle")}
        description={t("restoreMissingBody", { count: restoreMissing?.images ?? 1 })}
        confirmLabel={t("restoreWithoutImages")}
        variant="default"
        onConfirm={() => {
          const missing = restoreMissing;
          setRestoreMissing(null);
          if (missing) void restore(missing.source, true);
        }}
      />
      <ConfirmDialog
        open={removingLanding !== null}
        onOpenChange={(open) => { if (!open) setRemovingLanding(null); }}
        title={t("removeLandingTitle", { name: removingLanding ? theme.pages.landing[removingLanding]?.title ?? removingLanding : "" })}
        description={t("removeLandingBody")}
        confirmLabel={t("removeLanding")}
        onConfirm={() => {
          const slug = removingLanding;
          setRemovingLanding(null);
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
