// The one way a create form keeps its unsaved values across a reload, a
// closed tab or a crash (lib/create-drafts.ts): every create page calls it.
// While the form has unsaved changes its values are written to this device
// each second and as the page goes away; on return it offers them back
// ("Restore your unsaved draft?"). Inside a save scope the offer shows in
// the page's save banner and the draft goes once the record is created or
// the merchant discards; a page without one renders `offer` and calls
// `clear()` itself. The leave warning stays: this is what survives it.
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { History } from "lucide-react";
import { formatDateTime, useMessages } from "~/i18n";
import { createDraftMessages } from "~/i18n/create-draft";
import {
  createDraftKey,
  draftableValues,
  readCreateDraft,
  removeCreateDraft,
  secretInputNames,
  writeCreateDraft,
  type StoredDraft,
} from "~/lib/create-drafts";
import { SaveScopeDraftContext, useSaveScope } from "./SaveBar";

const WRITE_EVERY_MS = 1_000;

export interface CreateDraftOptions<T> {
  /** A create form this staff member can save; false keeps nothing. */
  enabled: boolean;
  /** The current values, read when written (plain data; secrets are dropped). */
  read: () => T;
  /** Puts restored values back on the form as unsaved changes. */
  restore: (values: T) => void;
  /** Has unsaved changes; inside a save scope, the scope's own answer by default. */
  dirty?: boolean;
  /** Which form, when one address holds more than one; the page's address by default. */
  form?: string;
}

export function useCreateDraft<T>({ enabled, read, restore, dirty: ownDirty, form }: CreateDraftOptions<T>): {
  /** The restore offer, for a page without a save scope to render (null inside one: the banner shows it). */
  offer: ReactNode;
  /** After the record was created. */
  clear: () => void;
  /** After the merchant discarded the form. */
  discard: () => void;
} {
  const t = useMessages(createDraftMessages);
  const scope = useSaveScope();
  const slot = useContext(SaveScopeDraftContext);
  const dirty = ownDirty ?? Boolean(scope?.navigationDirty);
  const [key] = useState(() => (typeof window === "undefined" ? null : createDraftKey(form ?? `${window.location.pathname}${window.location.search}`)));
  const [offered, setOffered] = useState<StoredDraft<T> | null>(() => (enabled && key ? readCreateDraft<T>(key) : null));
  const latest = useRef({ enabled, dirty, read, offered });
  latest.current = { enabled, dirty, read, offered };
  const written = useRef<string | null>(null);
  const done = useRef(false);
  /** The values the merchant discarded: never written back (a page that remounts on Discard still holds them as it goes). */
  const discarded = useRef<string | null>(null);
  const valuesJson = useCallback(() => JSON.stringify(draftableValues(latest.current.read(), secretInputNames())), []);

  /** The record was created: nothing to keep from this page any more. */
  const clear = useCallback(() => {
    done.current = true;
    if (key) removeCreateDraft(key);
    setOffered(null);
  }, [key]);
  /** The merchant discarded: the kept draft goes, and what they type next is kept again. */
  const discard = useCallback(() => {
    if (key) removeCreateDraft(key);
    discarded.current = valuesJson();
    written.current = null;
    setOffered(null);
  }, [key, valuesJson]);

  const flush = useCallback(() => {
    const current = latest.current;
    if (!key || done.current || !current.enabled) return;
    // An offer still open is the kept draft: a clean form never overwrites it.
    if (!current.dirty) {
      if (!current.offered && written.current !== null) {
        removeCreateDraft(key);
        written.current = null;
      }
      return;
    }
    const json = valuesJson();
    if (json === written.current || json === discarded.current) return;
    discarded.current = null;
    writeCreateDraft(key, json);
    written.current = json;
  }, [key, valuesJson]);

  useEffect(() => {
    if (!enabled || !key) return;
    const timer = setInterval(flush, WRITE_EVERY_MS);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [enabled, key, flush]);

  // A successful create, or Discard, takes the draft off: heard even once this page is gone.
  const listening = useRef(false);
  useEffect(() => {
    if (!slot || listening.current) return;
    listening.current = true;
    slot.listen({ saved: clear, discarded: discard });
  }, [slot, clear, discard]);

  // Starting over by hand replaces the old draft.
  useEffect(() => {
    if (offered && dirty) setOffered(null);
  }, [offered, dirty]);

  // A reload can bring the page back scrolled down: the offer is the first thing to decide, so it comes into view once.
  const offerRef = useRef<HTMLDivElement | null>(null);
  const shownOnce = useRef(false);
  useEffect(() => {
    if (!offered || shownOnce.current) return;
    const frame = requestAnimationFrame(() => {
      if (!offerRef.current) return;
      shownOnce.current = true;
      offerRef.current.scrollIntoView?.({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  });

  const offer = offered ? (
    <Alert ref={offerRef} variant="info" role="status" data-create-draft-offer="">
      <History aria-hidden="true" />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription>
        <p>{t("body", { when: formatDateTime(new Date(offered.savedAt), { dateStyle: "medium", timeStyle: "short" }) })}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setOffered(null);
              restore(offered.values);
            }}
          >
            {t("restore")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={discard}>
            {t("discard")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  ) : null;

  useEffect(() => {
    if (!slot) return;
    slot.setOffer(offer);
    return () => slot.setOffer(null);
    // The offer node changes with the language and the kept draft only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, offered, t]);

  return { offer: slot ? null : offer, clear, discard };
}
