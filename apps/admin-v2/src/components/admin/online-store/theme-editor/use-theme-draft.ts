/**
 * The editor's document and its life on the server (research P15, P16,
 * P24): the working document with undo and redo (autosave never touches
 * them), autosave of what can be saved now (an invalid part keeps its saved
 * value, saveable-draft.ts) against the draft revision it started from, one
 * honest status, a conflict that names who saved, and publishing,
 * restoring and discarding with restore points kept by the server.
 */
import { announceSave, presenceKey } from "~/lib/realtime/store";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  postApiV1AdminSettingsThemeDiscard,
  postApiV1AdminSettingsThemeDraft,
  postApiV1AdminSettingsThemePublish,
  postApiV1AdminSettingsThemeRestore,
  postApiV1AdminSettingsThemeRestorePoint,
} from "@scalius/api-client/sdk";
import type { StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { toast } from "~/lib/toast";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { AdminApiResponseError, isAdminApiConflictError } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { themeWorkspaceQueryOptions, type ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { actionErrorText } from "../shared";
import { editorHistory, startHistory, type EditorAction } from "./editor-state";
import type { SaveStatus } from "./EditorTopBar";
import { saveableDraft, type DraftApps } from "./saveable-draft";
import { themeVersionsKey } from "./theme-history-queries";

type Theme = StorefrontThemeDocument;

/** The theme draft is one document: everyone in the editor shares this presence key. */
export const THEME_PRESENCE_KEY = presenceKey("theme", "draft");

/** How long the editor waits after the last edit before saving the draft. */
export const AUTOSAVE_DELAY_MS = 800;

const same = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

export interface SavedDraft {
  theme: Theme;
  revision: number;
  basePublishedRevision: number;
}

export interface Conflict {
  name: string | null;
  at: string | null;
}

export function useThemeDraft({ workspace, refetch, canEdit, apps }: {
  workspace: ThemeWorkspaceDocument;
  refetch: () => Promise<{ data?: ThemeWorkspaceDocument }>;
  canEdit: boolean;
  /** What the active apps declare: their values hold back like any invalid field. */
  apps: DraftApps;
}) {
  const t = useMessages(themeEditorMessages);
  const queryClient = useQueryClient();
  const [history, dispatchHistory] = useReducer(editorHistory, workspace.draft.theme as Theme, startHistory);
  const working = history.present;
  const [saved, setSaved] = useState<SavedDraft>({
    theme: workspace.draft.theme as Theme,
    revision: workspace.draft.revision,
    basePublishedRevision: workspace.draft.basePublishedRevision,
  });
  const [published, setPublished] = useState({ theme: workspace.published.theme as Theme, revision: workspace.published.revision });
  const [lastPublished, setLastPublished] = useState(workspace.lastPublished);
  /** The document last sent: unsaved means what can be saved differs from it. */
  const [lastSent, setLastSent] = useState<Theme>(workspace.draft.theme as Theme);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [failure, setFailure] = useState<{ for: Theme; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** Save without waiting (a change the preview shows only once saved). */
  const [urgent, setUrgent] = useState(false);

  const saveable = useMemo(() => saveableDraft(working, saved.theme, apps), [working, saved.theme, apps]);
  const pending = saveable?.theme ?? null;
  const dirty = useMemo(() => pending !== null && !same(pending, lastSent), [pending, lastSent]);
  const held = saveable?.held ?? [];
  const unsavedEdits = useMemo(() => !same(working, lastSent), [working, lastSent]);
  const failedHere = failure !== null && pending !== null && same(failure.for, pending);

  const dispatch = useCallback((action: EditorAction) => {
    if (!canEdit && action.type !== "replace") return;
    dispatchHistory(action);
  }, [canEdit]);
  const setDraft = useCallback((next: Theme | ((theme: Theme) => Theme)) => {
    dispatch({ type: "edit", update: (current) => (typeof next === "function" ? next(current) : next), at: Date.now() });
  }, [dispatch]);

  const latest = useRef({ pending, saved, saving, conflict, busy });
  latest.current = { pending, saved, saving, conflict, busy };

  /** Names who saved over the editor's draft, from the server's draft now. */
  const noteConflict = useCallback(async () => {
    setConflict({ name: null, at: null });
    try {
      const { data } = await refetch();
      setConflict({ name: data?.draft.updatedByName ?? null, at: data?.draft.updatedAt ?? null });
    } catch {
      // The banner still offers reload and overwrite.
    }
  }, [refetch]);

  const save = useCallback(async () => {
    const { pending: sending, saved: base, saving: running, conflict: blocked, busy: replacing } = latest.current;
    if (!sending || running || blocked || replacing) return false;
    setSaving(true);
    setUrgent(false);
    try {
      const result = await apiData(postApiV1AdminSettingsThemeDraft({
        body: { expectedDraftRevision: base.revision, basePublishedRevision: base.basePublishedRevision, theme: sending },
      }));
      setSaved({ theme: sending, revision: result.revision, basePublishedRevision: result.basePublishedRevision });
      setLastSent(sending);
      setFailure(null);
      // The other people in the editor hear it at once (realtime presence).
      announceSave(THEME_PRESENCE_KEY, result.revision);
      return true;
    } catch (error) {
      if (isAdminApiConflictError(error)) void noteConflict();
      else setFailure({ for: sending, message: actionErrorText(error) });
      return false;
    } finally {
      setSaving(false);
    }
  }, [noteConflict]);

  // Edits save themselves a moment after the last one (at once when the preview needs them saved).
  useEffect(() => {
    if (!canEdit || !dirty || saving || conflict || failedHere || busy) return;
    const timer = window.setTimeout(() => void save(), urgent ? 0 : AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pending, canEdit, dirty, saving, conflict, failedHere, busy, urgent, save]);

  // A store without a draft gets one, so the preview has a draft to render.
  useEffect(() => {
    if (canEdit && saved.revision === 0 && !saving && !conflict && !failure) void save();
  }, [canEdit, saved.revision, saving, conflict, failure, save]);

  /** The server's draft again (after a conflict, a restore or a discard); `keepEdits` saves ours over it next. */
  const reload = useCallback(async (keepEdits = false) => {
    setBusy(true);
    try {
      const { data } = await refetch();
      if (!data) return;
      const newer: SavedDraft = { theme: data.draft.theme as Theme, revision: data.draft.revision, basePublishedRevision: data.draft.basePublishedRevision };
      setSaved(newer);
      setLastSent(newer.theme);
      setPublished({ theme: data.published.theme as Theme, revision: data.published.revision });
      setLastPublished(data.lastPublished);
      if (!keepEdits) dispatchHistory({ type: "replace", theme: newer.theme });
      setConflict(null);
      setFailure(null);
    } catch (error) {
      toast.error(actionErrorText(error));
    } finally {
      setBusy(false);
    }
  }, [refetch]);

  /**
   * Restores a published version or a restore point to the draft, or discards
   * the draft's changes. The editor's unsaved edits are saved first, so the
   * restore point the server keeps holds them.
   */
  const replaceDraft = useCallback(async (source: { version: number } | { point: string } | null, withoutMissingImages = false): Promise<{ missingImages: number } | null> => {
    if (latest.current.pending && dirty) await save();
    setBusy(true);
    try {
      const { saved: base } = latest.current;
      const body = { expectedDraftRevision: base.revision, basePublishedRevision: base.basePublishedRevision };
      const options = withoutMissingImages ? { withoutMissingImages } : {};
      if (source === null) await apiData(postApiV1AdminSettingsThemeDiscard({ body }));
      else if ("version" in source) await apiData(postApiV1AdminSettingsThemeRestore({ body: { ...body, sourceRevision: source.version, ...options } }));
      else await apiData(postApiV1AdminSettingsThemeRestorePoint({ body: { ...body, id: source.point, ...options } }));
      toast.success(t(source === null ? "discarded" : "restored"));
      void queryClient.invalidateQueries({ queryKey: themeVersionsKey });
    } catch (error) {
      setBusy(false);
      if (isAdminApiConflictError(error)) void noteConflict();
      else if (source !== null && error instanceof AdminApiResponseError && error.code === "THEME_VERSION_IMAGES_MISSING") {
        const images = (error.details as { missingImages?: unknown } | undefined)?.missingImages;
        return { missingImages: typeof images === "number" ? images : 1 };
      } else toast.error(actionErrorText(error));
      return null;
    }
    setBusy(false);
    await reload();
    return null;
  }, [dirty, save, noteConflict, reload, queryClient, t]);

  /** Publishes: unsaved edits are saved first, then the exact saved revision goes live. */
  const publish = useCallback(async (note: string) => {
    setPublishing(true);
    try {
      if (dirty && !(await save())) return false;
      const { saved: base } = latest.current;
      const result = await apiData(postApiV1AdminSettingsThemePublish({
        body: { expectedPublishedRevision: published.revision, expectedDraftRevision: base.revision, ...(note ? { note } : {}) },
      }));
      setPublished({ theme: base.theme, revision: result.published.revision });
      // Publishing moves the draft onto the new live revision: later saves start from it.
      setSaved({ theme: base.theme, revision: result.draft.revision, basePublishedRevision: result.draft.basePublishedRevision });
      setLastPublished(result.lastPublished);
      void queryClient.invalidateQueries({ queryKey: themeVersionsKey });
      void queryClient.invalidateQueries({ queryKey: themeWorkspaceQueryOptions().queryKey });
      toast.success(t("published"));
      return true;
    } catch (error) {
      if (isAdminApiConflictError(error)) void noteConflict();
      else toast.error(actionErrorText(error));
      return false;
    } finally {
      setPublishing(false);
    }
  }, [dirty, save, published.revision, noteConflict, queryClient, t]);

  const status: SaveStatus = !canEdit ? "readOnly"
    : conflict ? "conflict"
      : saving ? "saving"
        : failedHere ? "failed"
          : saveable === null ? "held"
            : dirty ? "unsaved"
              : held.length > 0 ? "held"
                : "saved";
  /** The draft differs from what is live (saved or not). */
  const differsFromLive = useMemo(() => unsavedEdits || (saved.revision > 0 && !same(saved.theme, published.theme)), [unsavedEdits, saved, published.theme]);

  return {
    history,
    working,
    dispatch,
    setDraft,
    saved,
    published,
    lastPublished,
    pending,
    held,
    dirty,
    unsavedEdits,
    status,
    failureMessage: failedHere ? failure?.message ?? null : null,
    conflict,
    busy,
    publishing,
    differsFromLive,
    save,
    saveSoon: () => setUrgent(true),
    reload,
    replaceDraft,
    publish,
  };
}
