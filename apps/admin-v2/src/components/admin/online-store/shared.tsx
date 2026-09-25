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

/**
 * A web address as merchants type it: "example.com/blog" gets https://, and a
 * doubled scheme ("https://https://…") is written once.
 */
export function normalizeWebAddress(value: string): string {
  const trimmed = value.trim();
  const rest = trimmed.replace(/^(?:https?(?::\/*|\/+))+/i, "");
  if (!rest) return "";
  const insecure = /^http:\/\/(?!https?:)/i.test(trimmed);
  return `${insecure ? "http" : "https"}://${rest}`;
}

/** A full http(s) address with a real host name. */
export function isWebAddress(value: string): boolean {
  try {
    const url = new URL(normalizeWebAddress(value));
    return url.hostname.includes(".") && !/^https?$/i.test(url.hostname.split(".")[0] ?? "");
  } catch {
    return false;
  }
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
    if (sameValue(draft[key], previous[key])) continue;
    // A field the merchant removed (a preset without custom colours) stays removed.
    if (!(key in draft)) delete next[key];
    else next[key] = rebaseDraft(draft[key], previous[key], saved[key]);
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
  // `sent` is the draft a save sent; once that save succeeded, the next saved
  // version is its result and the draft is rebased from what was sent, so a
  // value the server normalised (trimmed, a URL) comes back clean while edits
  // typed during the save stay.
  const [state, setState] = useState<{ saved: T; draft: T; sent?: { draft: T; from: T; done: boolean } }>({
    saved,
    draft: saved,
  });
  let current = state;
  if (state.saved !== saved) {
    const sent = state.sent?.done ? state.sent : undefined;
    current = {
      saved,
      draft: rebaseDraft(state.draft, sent ? sent.draft : state.saved, saved),
      sent: sent ? undefined : state.sent,
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
      const draft = current.draft;
      setState((value) => ({ ...value, sent: { draft, from: value.saved, done: false } }));
      setSaving(true);
      try {
        await save(draft);
        setState((value) => {
          if (value.sent?.draft !== draft) return value;
          // The result already arrived while saving: rebase from what was sent now.
          if (value.saved !== value.sent.from) {
            return { saved: value.saved, draft: rebaseDraft(value.draft, draft, value.saved) };
          }
          return { ...value, sent: { ...value.sent, done: true } };
        });
      } catch (error) {
        setState((value) => (value.sent?.draft === draft ? { saved: value.saved, draft: value.draft } : value));
        throw error;
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
