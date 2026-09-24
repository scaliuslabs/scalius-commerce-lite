import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CircleAlert, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { getServerFnError } from "~/lib/api-helpers";
import { Button } from "~/components/ui/button";
import { AdminApiResponseError, readSettingsRevisionConflict } from "~/lib/admin-api-error";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import { ConfirmDialog } from "./ConfirmDialog";
import { UnsavedChangesGuard } from "./UnsavedChangesGuard";
import { translate, useMessages } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { resourceMessages } from "~/i18n/resource";

/**
 * A save that failed after the editor already showed the merchant why.
 * `lines` lists every problem for the save banner (one per field).
 */
export class SaveNotCompleted extends Error {
  constructor(message = translate(resourceMessages, "saveFailed"), readonly lines: string[] = [message]) {
    super(message);
    this.name = "SaveNotCompleted";
  }
}

/** One editable card (or dialog form) registered with a save scope. */
export interface SaveBarEntry {
  dirty: boolean;
  saving?: boolean;
  /** Dirty but not savable yet (inline validation, fail-closed lock, role). */
  invalid?: boolean;
  /** Names the card in the "couldn't save" banner, e.g. "Business details". */
  label?: string;
  /**
   * Where the API's body paths are shown: a map or function from path to the
   * control's DOM id (e.g. `(path) => \`business-${path}\``). A rejected field
   * that is on screen is marked in place (`SettingsField`) instead of listed
   * in the banner. A nested path (`sources.2`) falls back to its first segment.
   */
  fields?: Record<string, string> | ((path: string) => string | undefined);
  /** Rejects when the save failed; the error's message is listed in the banner. */
  save: () => Promise<unknown>;
  discard: () => void;
  /**
   * After a settings revision conflict (someone else saved first): loads the
   * latest saved values and keeps this card's edits. The banner offers it.
   */
  reload?: () => Promise<unknown>;
}

/**
 * Why the last save failed, so the bar and banner offer the one action that
 * helps: fix the fields, try again, or reload what someone else saved.
 */
export type SaveFailureKind = "validation" | "connection" | "conflict";

export interface SaveScopeState {
  dirty: boolean;
  busy: boolean;
  invalid: boolean;
  /** Problems from the last save that no field shows, one line each. */
  errors: string[];
  /** Control id → what's wrong with it, from the last save. */
  fieldErrors: Record<string, string>;
  /** The last save failed (listed problems or marked fields). */
  failed: boolean;
  /** What kind of failure that was; null when the last save didn't fail. */
  failure: SaveFailureKind | null;
  /** Save was pressed while fields were invalid; their messages are showing. */
  revealed: boolean;
  /** Saves every dirty entry; false when any failed (their edits are kept). */
  saveAll: () => Promise<boolean>;
  discardAll: () => void;
}

interface SaveRegistry {
  set(id: string, entry: SaveBarEntry): void;
  remove(id: string): void;
}

const SaveBarContext = createContext<SaveRegistry | null>(null);
/** The scope's live state, for a page's own Save button or submit-on-Enter. */
const SaveStateContext = createContext<SaveScopeState | null>(null);
interface SaveFailure {
  /** Problems that can't be shown next to a field. */
  errors: string[];
  fieldErrors: Record<string, string>;
  /** Cards refused because someone else saved first, and their banner lines. */
  conflicts: Array<{ line: string; reload: () => Promise<unknown> }>;
  /** The other failures: input the server refused, or a server that couldn't be reached. */
  kind: "validation" | "connection" | null;
  attempt: number;
  /**
   * Inline validation shows once a field is left (blur). Pressing Save with
   * invalid fields reveals every field's message at once; this counts presses.
   */
  reveal: number;
}
const NO_FAILURE: SaveFailure = { errors: [], fieldErrors: {}, conflicts: [], kind: null, attempt: 0, reveal: 0 };
/** Kept apart from the registry so a failed save re-renders only the banner and marked fields. */
const SaveErrorsContext = createContext<SaveFailure & {
  clearField: (id: string) => void;
  reloadConflicts: () => Promise<void>;
}>({
  ...NO_FAILURE,
  clearField: () => {},
  reloadConflicts: async () => {},
});

/** What went wrong, in words a merchant can act on. */
function describeSaveError(error: unknown): string {
  if (readSettingsRevisionConflict(error)) return translate(saveBarMessages, "conflict");
  return getServerFnError(error);
}

/** Offline, timed out or a server fault: nothing for the merchant to fix, so Retry. */
function isConnectionFailure(error: unknown): boolean {
  if (error instanceof AdminApiResponseError) return error.status >= 500;
  return error instanceof Error && ["TypeError", "AbortError", "TimeoutError"].includes(error.name);
}

function failureKind(failure: SaveFailure): SaveFailureKind | null {
  if (failure.conflicts.length > 0) return "conflict";
  return failure.errors.length > 0 || Object.keys(failure.fieldErrors).length > 0 ? failure.kind : null;
}

/** The on-screen control (and its label) that shows an API body path. */
function findField(entry: SaveBarEntry, path: string): { id: string; label: string } | null {
  if (!entry.fields || typeof document === "undefined") return null;
  const resolve = (key: string) =>
    typeof entry.fields === "function" ? entry.fields(key) : entry.fields?.[key];
  for (const key of [path, path.split(".")[0]!]) {
    const id = resolve(key);
    if (!id || !document.getElementById(id)) continue;
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim();
    return { id, label: label || "" };
  }
  return null;
}

/**
 * Banner lines for one failed entry. A problem shown next to its field is
 * marked there only (one indicator per field); the rest are listed.
 */
function readFailure(entry: SaveBarEntry, error: unknown, fieldErrors: Record<string, string>): string[] {
  const prefix = entry.label ? `${entry.label}: ` : "";
  if (error instanceof SaveNotCompleted) return error.lines.map((line) => prefix + line);
  const issues = readApiFieldIssues(error);
  if (!issues) return [prefix + describeSaveError(error)];
  return issues.flatMap((issue) => {
    const field = findField(entry, issue.path);
    if (!field) return [prefix + issue.message];
    fieldErrors[field.id] ??= issue.message;
    return [];
  });
}

/**
 * Collects the drafts of everything rendered inside it. `render` draws the
 * controls: the page save bar below, or a dialog's Cancel/Save footer.
 */
export function SaveScope({
  children,
  render,
  savedMessage,
}: {
  children: ReactNode;
  render: (state: SaveScopeState) => ReactNode;
  /** The success toast, e.g. "Category saved" or "Invite sent"; "Changes saved" by default. */
  savedMessage?: string;
}) {
  const t = useMessages(saveBarMessages);
  const entries = useRef(new Map<string, SaveBarEntry>());
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure>(NO_FAILURE);
  const clearField = useCallback((id: string) => {
    setFailure((previous) => {
      if (!(id in previous.fieldErrors)) return previous;
      const { [id]: _cleared, ...rest } = previous.fieldErrors;
      return { ...previous, fieldErrors: rest };
    });
  }, []);
  const reloadConflicts = useCallback(async () => {
    const reloaded = failure.conflicts;
    await Promise.all(reloaded.map((conflict) => conflict.reload()));
    // The edits now sit on the latest version: Save again applies them.
    setFailure((previous) => ({
      ...previous,
      errors: previous.errors.filter((line) => !reloaded.some((conflict) => conflict.line === line)),
      conflicts: previous.conflicts.filter((conflict) => !reloaded.includes(conflict)),
    }));
  }, [failure.conflicts]);
  const errorsValue = useMemo(
    () => ({ ...failure, clearField, reloadConflicts }),
    [failure, clearField, reloadConflicts],
  );

  const registry = useMemo<SaveRegistry>(() => ({
    set(id, entry) {
      const previous = entries.current.get(id);
      entries.current.set(id, entry);
      if (
        !previous ||
        previous.dirty !== entry.dirty ||
        Boolean(previous.saving) !== Boolean(entry.saving) ||
        Boolean(previous.invalid) !== Boolean(entry.invalid)
      ) {
        rerender();
      }
    },
    remove(id) {
      if (entries.current.delete(id)) rerender();
    },
  }), []);

  const list = [...entries.current.values()];
  const state: SaveScopeState = {
    dirty: list.some((entry) => entry.dirty),
    busy: saving || list.some((entry) => entry.saving),
    invalid: list.some((entry) => entry.dirty && entry.invalid),
    errors: failure.errors,
    fieldErrors: failure.fieldErrors,
    failed: failure.errors.length > 0 || Object.keys(failure.fieldErrors).length > 0,
    failure: failureKind(failure),
    revealed: failure.reveal > 0,
    async saveAll() {
      if (list.some((entry) => entry.dirty && entry.invalid)) {
        // Shopify: Save stays pressable; it shows what to fix instead of saving.
        setFailure((previous) => ({ ...previous, reveal: previous.reveal + 1 }));
        return false;
      }
      setSaving(true);
      const errors: string[] = [];
      const fieldErrors: Record<string, string> = {};
      const conflicts: SaveFailure["conflicts"] = [];
      let kind: SaveFailure["kind"] = null;
      let failed = false;
      try {
        // Cards are separate documents: save each, keep the edits of any that fail.
        for (const entry of [...entries.current.values()]) {
          if (!entry.dirty) continue;
          try {
            await entry.save();
          } catch (error) {
            failed = true;
            const lines = readFailure(entry, error, fieldErrors);
            errors.push(...lines);
            if (entry.reload && readSettingsRevisionConflict(error)) {
              conflicts.push({ line: lines[0]!, reload: entry.reload });
            } else if (kind !== "validation") {
              // Something to fix outranks "try again": a retry can't fix it.
              kind = isConnectionFailure(error) ? "connection" : "validation";
            }
          }
        }
      } finally {
        setSaving(false);
      }
      setFailure((previous) => ({
        errors,
        fieldErrors,
        conflicts,
        kind,
        attempt: previous.attempt + 1,
        reveal: failed ? previous.reveal : 0,
      }));
      if (!failed) toast.success(savedMessage ?? t("saved"));
      return !failed;
    },
    discardAll() {
      for (const entry of entries.current.values()) {
        if (entry.dirty) entry.discard();
      }
      setFailure((previous) => ({ ...NO_FAILURE, attempt: previous.attempt }));
    },
  };

  return (
    <SaveBarContext.Provider value={registry}>
      <SaveErrorsContext.Provider value={errorsValue}>
        <SaveStateContext.Provider value={state}>
          {children}
          {render(state)}
        </SaveStateContext.Provider>
      </SaveErrorsContext.Provider>
    </SaveBarContext.Provider>
  );
}

/**
 * The last save's verdict on one control, and a way to clear it once the
 * merchant edits it. `SettingsField` does this for its `id`.
 */
export function useServerFieldError(id: string): { error: string | undefined; clear: () => void; revealed: boolean } {
  const { fieldErrors, clearField, reveal } = useContext(SaveErrorsContext);
  return { error: fieldErrors[id], clear: () => clearField(id), revealed: reveal > 0 };
}

/**
 * Shopify's server-error banner: put it under the page (or dialog) title.
 * After a failed save it lists the problems and moves focus to the first
 * invalid field, or to itself when no field is marked.
 */
export function SaveErrorBanner() {
  const t = useMessages(saveBarMessages);
  const failure = useContext(SaveErrorsContext);
  const { errors, fieldErrors, conflicts, attempt, reveal, reloadConflicts } = failure;
  const scope = useContext(SaveStateContext);
  const kind = failureKind(failure);
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [inDialog, setInDialog] = useState(false);
  const [reloading, setReloading] = useState(false);
  useLayoutEffect(() => {
    setInDialog(Boolean(anchor.current?.closest("[role=dialog]")));
  }, []);
  // Marked fields carry their own message. A page adds one count of them
  // (Polaris: "To save, fix 2 problems"); a dialog's fields are all in view.
  const marked = inDialog ? 0 : Object.keys(fieldErrors).length;
  useEffect(() => {
    if (reveal === 0) return;
    const container = anchor.current?.closest("[role=dialog]") ?? document;
    container.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
  }, [reveal]);
  // Once per failed save (not when a dialog reopens): the first marked field,
  // else the banner, takes focus.
  const seenAttempt = useRef(attempt);
  useEffect(() => {
    if (attempt === seenAttempt.current) return;
    seenAttempt.current = attempt;
    if (errors.length === 0 && Object.keys(fieldErrors).length === 0) return;
    const container = anchor.current?.closest("[role=dialog]") ?? document;
    const field = container.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])');
    const banner = ref.current;
    if (field) {
      field.focus();
    } else if (banner) {
      banner.focus();
      banner.scrollIntoView({ block: "nearest" });
    }
  }, [attempt, errors, fieldErrors]);
  const count = errors.length + marked;
  return (
    <>
      <span ref={anchor} hidden />
      {count === 0 ? null : (
        <Alert ref={ref} tabIndex={-1} variant="destructive" className="scroll-mt-4">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {kind !== "validation" || (count === 1 && errors.length)
              ? t("notSavedOne")
              : count === 1 ? t("fixOne") : t("notSavedMany", { count })}
          </AlertTitle>
          {errors.length === 0 ? null : (
            <AlertDescription>
              {errors.length === 1 ? (
                <p>{errors[0]}</p>
              ) : (
                <ul className="list-disc space-y-1 pl-4">
                  {errors.map((error) => <li key={error}>{error}</li>)}
                </ul>
              )}
              {conflicts.length === 0 ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  loading={reloading}
                  onClick={async () => {
                    setReloading(true);
                    try {
                      await reloadConflicts();
                    } finally {
                      setReloading(false);
                    }
                  }}
                >
                  {t("reloadKeepEdits")}
                </Button>
              )}
              {/* A dialog's own Save sits right below; a page gets Retry here. */}
              {kind === "connection" && scope && !inDialog ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  loading={scope.busy}
                  onClick={() => void scope.saveAll()}
                >
                  {t("retry")}
                </Button>
              ) : null}
            </AlertDescription>
          )}
        </Alert>
      )}
    </>
  );
}

/**
 * Shopify's contextual save bar for a whole page: a dark pill over the centre
 * of the top bar on desktop, a full-width strip over it on phones. Discard and
 * leaving the page with unsaved changes both ask first. A new record names
 * itself in the bar ("Unsaved product") and in the success toast.
 */
export function SaveBarProvider({
  children,
  unsavedLabel,
  savedMessage,
}: {
  children: ReactNode;
  unsavedLabel?: string;
  savedMessage?: string;
}) {
  return (
    <SaveScope savedMessage={savedMessage} render={(state) => <SaveBar state={state} unsavedLabel={unsavedLabel} />}>
      {children}
    </SaveScope>
  );
}

/** The bar sits on the near-black top bar, so its two buttons use the frame's tokens. */
const DISCARD_BUTTON =
  "relative inline-flex h-11 items-center rounded-lg bg-topbar-subdued px-4 text-body font-medium text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:h-8 sm:px-3";
const SAVE_BUTTON =
  "relative inline-flex h-11 items-center rounded-lg bg-topbar-foreground px-4 text-body font-medium text-topbar hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:h-8 sm:px-3";

function SaveBar({ state, unsavedLabel }: { state: SaveScopeState; unsavedLabel?: string }) {
  const t = useMessages(saveBarMessages);
  const { dirty, busy, invalid, failure, revealed } = state;
  // The bar says what happened and the one action that helps (Polaris: the bar mirrors the banner).
  const message =
    failure === "conflict" ? t("conflictBar")
      : failure === "connection" ? t("retryBar")
        : failure === "validation" ? (Object.keys(state.fieldErrors).length ? t("fixErrors") : t("notSavedBar"))
          : invalid && revealed ? t("fixErrors") : unsavedLabel ?? t("unsavedChanges");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const saveRef = useRef(state.saveAll);
  saveRef.current = state.saveAll;
  // Ctrl/⌘+S saves the page from any field while the bar shows.
  useEffect(() => {
    if (!dirty) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "s" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (!busy) void saveRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, busy]);
  return (
    <>
      <UnsavedChangesGuard isDirty={dirty} isSubmitting={busy} />
      <ConfirmDialog
        open={confirmDiscard && dirty}
        onOpenChange={setConfirmDiscard}
        title={t("discardTitle")}
        description={t("discardDescription")}
        cancelLabel={t("continueEditing")}
        confirmLabel={t("discardChanges")}
        onConfirm={() => {
          state.discardAll();
          setConfirmDiscard(false);
        }}
      />
      {dirty && typeof document !== "undefined"
        ? createPortal(
            <div
              role="region"
              data-save-bar=""
              aria-label={unsavedLabel ?? t("unsavedChanges")}
              className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between gap-2 border-b border-topbar-hover bg-topbar px-3 text-topbar-foreground sm:inset-x-auto sm:left-1/2 sm:top-1.5 sm:h-11 sm:min-w-lg sm:-translate-x-1/2 sm:gap-6 sm:rounded-full sm:border sm:pl-4 sm:pr-1"
            >
              <p className="flex min-w-0 items-center gap-2 text-body font-medium" aria-live="polite">
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{message}</span>
              </p>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  className={DISCARD_BUTTON}
                  disabled={busy}
                  onClick={() => setConfirmDiscard(true)}
                >
                  {t("discard")}
                </button>
                <button
                  type="button"
                  className={SAVE_BUTTON}
                  disabled={busy}
                  aria-busy={busy || undefined}
                  onClick={() => void state.saveAll()}
                >
                  <span className={busy ? "invisible" : undefined}>{t("save")}</span>
                  {busy ? (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    </span>
                  ) : null}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** The nearest save scope's state (null outside one), e.g. for an editor's own Save button. */
export function useSaveScope(): SaveScopeState | null {
  return useContext(SaveStateContext);
}

/**
 * Registers a card's draft with the nearest save scope. Returns whether one
 * is present, so an editor used outside one can keep its own buttons.
 */
export function useSaveBar(entry: SaveBarEntry): boolean {
  const registry = useContext(SaveBarContext);
  const id = useId();
  useLayoutEffect(() => {
    registry?.set(id, entry);
  });
  useEffect(() => () => registry?.remove(id), [registry, id]);
  return registry !== null;
}
