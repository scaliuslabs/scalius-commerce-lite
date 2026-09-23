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
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { UnsavedChangesGuard } from "./UnsavedChangesGuard";
import { useMessages } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";

/** One editable card (or dialog form) registered with a save scope. */
export interface SaveBarEntry {
  dirty: boolean;
  saving?: boolean;
  /** Dirty but not savable yet (inline validation, fail-closed lock, role). */
  invalid?: boolean;
  /** Rejects when the save failed; the card reports its own error. */
  save: () => Promise<unknown>;
  discard: () => void;
}

export interface SaveScopeState {
  dirty: boolean;
  busy: boolean;
  invalid: boolean;
  /** Saves every dirty entry in order; false when one failed (edits kept). */
  saveAll: () => Promise<boolean>;
  discardAll: () => void;
}

interface SaveRegistry {
  set(id: string, entry: SaveBarEntry): void;
  remove(id: string): void;
}

const SaveBarContext = createContext<SaveRegistry | null>(null);

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
    async saveAll() {
      setSaving(true);
      try {
        for (const entry of [...entries.current.values()]) {
          if (entry.dirty) await entry.save();
        }
        toast.success(t("saved"));
        return true;
      } catch {
        // The failing card already showed what went wrong and kept its edits.
        return false;
      } finally {
        setSaving(false);
      }
    },
    discardAll() {
      for (const entry of entries.current.values()) {
        if (entry.dirty) entry.discard();
      }
    },
  };

  return (
    <SaveBarContext.Provider value={registry}>
      {children}
      {render(state)}
    </SaveBarContext.Provider>
  );
}

/**
 * Shopify's contextual save bar for a whole page: a dark pill over the centre
 * of the top bar on desktop, a full-width strip over it on phones. Leaving the
 * page with unsaved changes asks to discard.
 */
export function SaveBarProvider({ children }: { children: ReactNode }) {
  return <SaveScope render={(state) => <SaveBar state={state} />}>{children}</SaveScope>;
}

function SaveBar({ state }: { state: SaveScopeState }) {
  const t = useMessages(saveBarMessages);
  const { dirty, busy, invalid } = state;
  return (
    <>
      <UnsavedChangesGuard isDirty={dirty} isSubmitting={busy} />
      {dirty && typeof document !== "undefined"
        ? createPortal(
            <div
              role="region"
              aria-label={t("unsavedChanges")}
              className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between gap-2 bg-zinc-900 px-3 text-white shadow-lg dark:bg-zinc-800 dark:ring-1 dark:ring-white/10 sm:inset-x-auto sm:left-1/2 sm:top-2.5 sm:h-9 sm:-translate-x-1/2 sm:gap-6 sm:rounded-full sm:pl-4 sm:pr-1"
            >
              <p className="flex min-w-0 items-center gap-2 text-sm font-medium" aria-live="polite">
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{invalid ? t("fixErrors") : t("unsavedChanges")}</span>
              </p>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11 text-white hover:bg-white/15 hover:text-white sm:h-7 sm:min-h-7 sm:rounded-full"
                  disabled={busy}
                  onClick={state.discardAll}
                >
                  {t("discard")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11 min-w-16 bg-white text-zinc-900 hover:bg-white/90 sm:h-7 sm:min-h-7 sm:rounded-full"
                  disabled={busy || invalid}
                  onClick={() => void state.saveAll()}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {busy ? t("saving") : t("save")}
                </Button>
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
