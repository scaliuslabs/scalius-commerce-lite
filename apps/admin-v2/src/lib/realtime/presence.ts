/**
 * Presence and live save notices for revision-fenced editors, over the
 * realtime seam (store.ts). Kept apart so list screens that only hear
 * notices do not load it.
 */
import { createContext, useEffect, useRef, useState } from "react";
import type { RealtimePerson } from "@scalius/shared/realtime";
import { realtimeUserId, subscribeRealtime, watchKey } from "./store";

/**
 * The presence key of the page around a card (a settings page): cards that
 * save on their own announce their saves under it.
 */
export const PresenceScopeContext = createContext<string | null>(null);

export interface EditorPresence {
  /** Other staff on this editor now (never the viewer). */
  others: RealtimePerson[];
  /** The last save by someone else since this editor opened, until dismissed. */
  remoteSave: { by: RealtimePerson; rev: number | null; at: number } | null;
  dismissRemoteSave(): void;
}

/**
 * Presence and live save notices for one revision-fenced editor. `key` is
 * `presenceKey(prefix, id)`; null turns it off (a new, unsaved record).
 * `currentRev` drops a save notice for a revision this editor already has.
 */
export function useEditorPresence(key: string | null, currentRev?: number | null): EditorPresence {
  const [others, setOthers] = useState<RealtimePerson[]>([]);
  const [remoteSave, setRemoteSave] = useState<EditorPresence["remoteSave"]>(null);
  const rev = useRef(currentRev ?? null);
  rev.current = currentRev ?? null;
  useEffect(() => {
    setOthers([]);
    setRemoteSave(null);
    if (!key) return;
    const release = watchKey(key);
    const unsubscribe = subscribeRealtime({
      presence: (presenceKey, people) => {
        if (presenceKey !== key) return;
        setOthers(people.filter((person) => person.id !== realtimeUserId()));
      },
      saved: (savedKey, by, savedRev) => {
        if (savedKey !== key) return;
        if (savedRev !== null && rev.current !== null && savedRev <= rev.current) return;
        setRemoteSave({ by, rev: savedRev, at: Date.now() });
      },
      status: (next) => {
        if (next !== "open") setOthers([]);
      },
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [key]);
  return { others, remoteSave, dismissRemoteSave: () => setRemoteSave(null) };
}
