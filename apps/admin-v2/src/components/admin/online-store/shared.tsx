import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { SaveErrorBanner, useSaveBar, type SaveBarEntry } from "~/components/admin/shared/SaveBar";
import { AdminApiResponseError, isAdminApiConflictError } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

export { SettingsCard as SectionCard, SettingsField as Field } from "~/components/admin/settings/SettingsPage";

/** One page header, the save-error banner, then one column of cards (Shopify layout). */
export function OnlineStorePage({
  title,
  back,
  actions,
  children,
}: {
  title: ReactNode;
  /** A parent page: shows the back arrow. */
  back?: { to: "/admin/online-store/navigation"; label: string };
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 pb-10">
      <div className="flex min-h-11 flex-wrap items-center gap-2 lg:min-h-9">
        {back ? (
          <Link
            to={back.to}
            aria-label={back.label}
            className="-ml-2 grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground lg:size-9"
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Link>
        ) : null}
        <h1 className="mr-auto min-w-0 text-heading-lg">{title}</h1>
        {actions}
      </div>
      <SaveErrorBanner />
      {children}
    </div>
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A newer saved version (another session's save, a reload after a conflict)
 * under the merchant's draft: fields they edited keep their edit, the rest
 * take the newer value, down to nested fields (theme colours, checkout
 * texts), so saving again never writes back stale fields.
 */
export function rebaseDraft<T>(draft: T, previous: T, saved: T): T {
  if (sameValue(draft, previous)) return saved;
  if (!isPlainObject(draft) || !isPlainObject(previous) || !isPlainObject(saved)) return draft;
  const next: Record<string, unknown> = { ...saved };
  for (const key of Object.keys({ ...previous, ...draft })) {
    if (!sameValue(draft[key], previous[key])) next[key] = rebaseDraft(draft[key], previous[key], saved[key]);
  }
  return next as T;
}

/**
 * A card's editable copy of one saved document. Registers with the page save
 * bar; a newer saved value is merged under the draft field by field. `saved`
 * must keep its identity until the document changes (memoize derived values).
 */
export function useDocumentDraft<T>({
  label,
  saved,
  save,
  invalid,
  fields,
  reload,
}: {
  /** Card name, shown before this card's error in the save banner. */
  label?: string;
  saved: T;
  save: (draft: T) => Promise<unknown>;
  /** True while the draft cannot be saved; the card's fields say why. */
  invalid?: (draft: T) => boolean;
  /** API body path → control id, so a rejected field is marked in place. */
  fields?: (path: string, draft: T) => string | undefined;
  /** Refetches `saved` after a revision conflict ("Reload and keep my edits"). */
  reload?: () => Promise<unknown>;
}) {
  const [state, setState] = useState({ saved, draft: saved });
  let current = state;
  if (state.saved !== saved) {
    current = {
      saved,
      draft: rebaseDraft(state.draft, state.saved, saved),
    };
    setState(current);
  }
  const [saving, setSaving] = useState(false);
  const dirty = !sameValue(current.draft, current.saved);

  const entry: SaveBarEntry = {
    label,
    dirty,
    saving,
    invalid: invalid?.(current.draft) ?? false,
    save: async () => {
      setSaving(true);
      try {
        await save(current.draft);
      } finally {
        setSaving(false);
      }
    },
    discard: () => setState((value) => ({ ...value, draft: value.saved })),
    reload,
  };
  if (fields) entry.fields = (path) => fields(path, current.draft);
  useSaveBar(entry);

  return {
    draft: current.draft,
    dirty,
    setDraft: (next: T | ((draft: T) => T)) =>
      setState((value) => ({
        ...value,
        draft: typeof next === "function" ? (next as (draft: T) => T)(value.draft) : next,
      })),
  };
}

/**
 * Rethrows so the save bar keeps the edits and lists the error. After a
 * revision conflict the newer saved version is loaded under the kept edits,
 * so saving again keeps the merchant's changes.
 */
export function failSave(error: unknown, reload: () => void): never {
  if (isAdminApiConflictError(error)) {
    reload();
    throw new Error(translate(onlineStoreMessages, "conflict"));
  }
  throw error;
}

/**
 * What a failed immediate action (add, move, delete) tells the merchant: the
 * API's own sentence for a 4xx, never raw server or network text.
 */
export function actionErrorText(error: unknown): string {
  if (error instanceof AdminApiResponseError && error.status < 500 && error.message && !error.message.startsWith("API error")) {
    return error.message;
  }
  return translate(onlineStoreMessages, "actionFailed");
}
