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
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import { ConfirmDialog } from "./ConfirmDialog";
import { UnsavedChangesGuard } from "./UnsavedChangesGuard";
import { translate, useMessages } from "~/i18n";
import { fieldErrorMessages, saveBarMessages } from "~/i18n/save-bar";

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
   * that is on screen is marked in place (`SettingsField`) and named by its
   * label in the banner. A nested path (`sources.2`) falls back to its first
   * segment.
   */
  fields?: Record<string, string> | ((path: string) => string | undefined);
  /** Rejects when the save failed; the error's message is listed in the banner. */
  save: () => Promise<unknown>;
  discard: () => void;
}

export interface SaveScopeState {
  dirty: boolean;
  busy: boolean;
  invalid: boolean;
  /** Problems from the last save, one line each; empty after a clean save. */
  errors: string[];
  /** Control id → what's wrong with it, from the last save. */
  fieldErrors: Record<string, string>;
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
interface SaveFailure {
  errors: string[];
  fieldErrors: Record<string, string>;
  attempt: number;
  /**
   * Inline validation shows once a field is left (blur). Pressing Save with
   * invalid fields reveals every field's message at once; this counts presses.
   */
  reveal: number;
}
const NO_FAILURE: SaveFailure = { errors: [], fieldErrors: {}, attempt: 0, reveal: 0 };
/** Kept apart from the registry so a failed save re-renders only the banner and marked fields. */
const SaveErrorsContext = createContext<SaveFailure & { clearField: (id: string) => void }>({
  ...NO_FAILURE,
  clearField: () => {},
});

/** What went wrong, in words a merchant can act on. */
function describeSaveError(error: unknown): string {
  if (error instanceof AdminApiResponseError) {
    // A request-validation rejection nobody mapped carries a JSON issue list as its message.
    if (error.status < 500 && error.message.startsWith("[")) return translate(fieldErrorMessages, "invalid");
    return error.status < 500 && error.message && !error.message.startsWith("API error")
      ? error.message
      : translate(saveBarMessages, "serverError");
  }
  if (error instanceof Error) {
    if (["TypeError", "AbortError", "TimeoutError"].includes(error.name)) {
      return translate(saveBarMessages, "offline");
    }
    return error.message || translate(saveBarMessages, "serverError");
  }
  return translate(saveBarMessages, "serverError");
}

/** Banner lines for one failed entry; marks the fields it can place. */
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

/** Banner lines for one failed entry; marks the fields it can place. */
function readFailure(entry: SaveBarEntry, error: unknown, fieldErrors: Record<string, string>): string[] {
  const prefix = entry.label ? `${entry.label}: ` : "";
  const issues = readApiFieldIssues(error);
  if (!issues) return [prefix + describeSaveError(error)];
  return issues.map((issue) => {
    const field = findField(entry, issue.path);
    if (!field) return prefix + issue.message;
    fieldErrors[field.id] ??= issue.message;
    return field.label ? `${field.label}: ${issue.message}` : prefix + issue.message;
  });
}

/**
 * Collects the drafts of everything rendered inside it. `render` draws the
 * controls: the page save bar below, or a dialog's Cancel/Save footer.
 */
export function SaveScope({
  children,
  render,
}: {
  children: ReactNode;
  render: (state: SaveScopeState) => ReactNode;
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
  const errorsValue = useMemo(() => ({ ...failure, clearField }), [failure, clearField]);

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
      try {
        // Cards are separate documents: save each, keep the edits of any that fail.
        for (const entry of [...entries.current.values()]) {
          if (!entry.dirty) continue;
          try {
            await entry.save();
          } catch (error) {
            errors.push(...readFailure(entry, error, fieldErrors));
          }
        }
      } finally {
        setSaving(false);
      }
      setFailure((previous) => ({ errors, fieldErrors, attempt: previous.attempt + 1, reveal: errors.length ? previous.reveal : 0 }));
      if (errors.length === 0) toast.success(t("saved"));
      return errors.length === 0;
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
        {children}
        {render(state)}
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
  const { errors, attempt, reveal } = useContext(SaveErrorsContext);
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reveal === 0) return;
    const container = anchor.current?.closest("[role=dialog]") ?? document;
    container.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
  }, [reveal]);
  useEffect(() => {
    const banner = ref.current;
    if (!banner || errors.length === 0) return;
    const container = banner.closest("[role=dialog]") ?? document;
    const field = container.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])');
    if (field) {
      field.focus();
    } else {
      banner.focus();
      banner.scrollIntoView({ block: "nearest" });
    }
  }, [errors, attempt]);
  if (errors.length === 0) return <span ref={anchor} hidden />;
  return (
    <Alert ref={ref} tabIndex={-1} variant="destructive" className="scroll-mt-4">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{errors.length === 1 ? t("notSavedOne") : t("notSavedMany", { count: errors.length })}</AlertTitle>
      <AlertDescription>
        {errors.length === 1 ? (
          <p>{errors[0]}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-4">
            {errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Shopify's contextual save bar for a whole page: a dark pill over the centre
 * of the top bar on desktop, a full-width strip over it on phones. Discard and
 * leaving the page with unsaved changes both ask first.
 */
export function SaveBarProvider({ children }: { children: ReactNode }) {
  return <SaveScope render={(state) => <SaveBar state={state} />}>{children}</SaveScope>;
}

/** The bar sits on the near-black top bar, so its two buttons use the frame's tokens. */
const DISCARD_BUTTON =
  "relative inline-flex h-11 items-center rounded-lg bg-topbar-subdued px-4 text-body font-medium text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:h-8 sm:px-3";
const SAVE_BUTTON =
  "relative inline-flex h-11 items-center rounded-lg bg-topbar-foreground px-4 text-body font-medium text-topbar hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:h-8 sm:px-3";

function SaveBar({ state }: { state: SaveScopeState }) {
  const t = useMessages(saveBarMessages);
  const { dirty, busy, invalid, errors, revealed } = state;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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
              aria-label={t("unsavedChanges")}
              className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between gap-2 border-b border-topbar-hover bg-topbar px-3 text-topbar-foreground sm:inset-x-auto sm:left-1/2 sm:top-1.5 sm:h-11 sm:min-w-lg sm:-translate-x-1/2 sm:gap-6 sm:rounded-full sm:border sm:pl-4 sm:pr-1"
            >
              <p className="flex min-w-0 items-center gap-2 text-body font-medium" aria-live="polite">
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {errors.length > 0 ? t("notSavedBar") : invalid && revealed ? t("fixErrors") : t("unsavedChanges")}
                </span>
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
