import {
  createContext,
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
import { ConfirmDialog } from "./ConfirmDialog";
import { UnsavedChangesGuard } from "./UnsavedChangesGuard";
import { translate, useMessages } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";

/** One editable card (or dialog form) registered with a save scope. */
export interface SaveBarEntry {
  dirty: boolean;
  saving?: boolean;
  /** Dirty but not savable yet (inline validation, fail-closed lock, role). */
  invalid?: boolean;
  /** Names the card in the "couldn't save" banner, e.g. "Business details". */
  label?: string;
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
  /** Saves every dirty entry; false when any failed (their edits are kept). */
  saveAll: () => Promise<boolean>;
  discardAll: () => void;
}

interface SaveRegistry {
  set(id: string, entry: SaveBarEntry): void;
  remove(id: string): void;
}

const SaveBarContext = createContext<SaveRegistry | null>(null);
/** Kept apart from the registry so a failed save re-renders only the banner. */
const SaveErrorsContext = createContext<{ errors: string[]; attempt: number }>({ errors: [], attempt: 0 });

/** What went wrong, in words a merchant can act on. */
function describeSaveError(error: unknown): string {
  if (error instanceof AdminApiResponseError) {
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
  const [failure, setFailure] = useState({ errors: [] as string[], attempt: 0 });

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
    async saveAll() {
      setSaving(true);
      const errors: string[] = [];
      try {
        // Cards are separate documents: save each, keep the edits of any that fail.
        for (const entry of [...entries.current.values()]) {
          if (!entry.dirty) continue;
          try {
            await entry.save();
          } catch (error) {
            const message = describeSaveError(error);
            errors.push(entry.label ? `${entry.label}: ${message}` : message);
          }
        }
      } finally {
        setSaving(false);
      }
      setFailure((previous) => ({ errors, attempt: previous.attempt + 1 }));
      if (errors.length === 0) toast.success(t("saved"));
      return errors.length === 0;
    },
    discardAll() {
      for (const entry of entries.current.values()) {
        if (entry.dirty) entry.discard();
      }
      setFailure((previous) => ({ errors: [], attempt: previous.attempt }));
    },
  };

  return (
    <SaveBarContext.Provider value={registry}>
      <SaveErrorsContext.Provider value={failure}>
        {children}
        {render(state)}
      </SaveErrorsContext.Provider>
    </SaveBarContext.Provider>
  );
}

/**
 * Shopify's server-error banner: put it under the page (or dialog) title.
 * After a failed save it lists the problems and moves focus to the first
 * invalid field, or to itself when no field is marked.
 */
export function SaveErrorBanner() {
  const t = useMessages(saveBarMessages);
  const { errors, attempt } = useContext(SaveErrorsContext);
  const ref = useRef<HTMLDivElement>(null);
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
  if (errors.length === 0) return null;
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
  const { dirty, busy, invalid, errors } = state;
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
                  {errors.length > 0 ? t("notSavedBar") : invalid ? t("fixErrors") : t("unsavedChanges")}
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
                  disabled={busy || invalid}
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
