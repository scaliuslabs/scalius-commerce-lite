import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Card } from "~/components/ui/card";
import { useSaveBar } from "~/components/admin/shared/SaveBar";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { translate } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

/** One page header + one column of cards (Shopify layout). */
export function OnlineStorePage({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 pb-10">
      <div className="flex min-h-10 items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{title}</h1>
        {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children ? <div className="space-y-4 px-4 pb-4">{children}</div> : null}
    </Card>
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
  saved,
  save,
  invalid,
}: {
  saved: T;
  save: (draft: T) => Promise<unknown>;
  /** True while the draft cannot be saved; the card shows why. */
  invalid?: (draft: T) => boolean;
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

  useSaveBar({
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
  });

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

/** Shows why a save failed, then rethrows so the save bar keeps the edits. */
export function failSave(error: unknown, reload: () => void): never {
  if (isAdminApiConflictError(error)) {
    toast.error(translate(onlineStoreMessages, "conflict"), {
      action: { label: translate(onlineStoreMessages, "reload"), onClick: reload },
    });
  } else {
    toast.error(translate(onlineStoreMessages, "saveFailed"), {
      description: getServerFnError(error, translate(onlineStoreMessages, "tryAgain")),
    });
  }
  throw error;
}
