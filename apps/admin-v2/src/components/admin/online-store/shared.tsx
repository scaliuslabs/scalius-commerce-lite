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

/**
 * A card's editable copy of one saved document. Registers with the page save
 * bar; a newer saved value replaces the draft only when the card is clean.
 */
export function useDocumentDraft<T>({
  label,
  saved,
  save,
  invalid,
  fields,
}: {
  /** Card name, shown before this card's error in the save banner. */
  label: string;
  saved: T;
  save: (draft: T) => Promise<unknown>;
  /** True while the draft cannot be saved; the card's fields say why. */
  invalid?: (draft: T) => boolean;
  /** API body path → control id, so a rejected field is marked in place. */
  fields?: (path: string, draft: T) => string | undefined;
}) {
  const [state, setState] = useState({ saved, draft: saved });
  let current = state;
  if (state.saved !== saved) {
    current = {
      saved,
      draft: sameValue(state.draft, state.saved) ? saved : state.draft,
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
