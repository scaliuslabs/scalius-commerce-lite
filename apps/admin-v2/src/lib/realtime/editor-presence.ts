/**
 * One editor's presence state: who else is on its key and their last save.
 * Used by the lazily loaded presence view and by the theme editor (which
 * loads another person's save at once).
 */
import { useEffect, useRef, useState } from "react";
import type { RealtimePerson, RealtimePresence } from "@scalius/shared/realtime";
import { realtimeUserId, subscribeRealtime, watchKey } from "./store";

let saveStamp = 0;

export interface RemoteSave {
  by: RealtimePerson;
  rev: number | null;
  /** The fields they changed (form names), when their editor said. */
  fields: string[];
  /** When it arrived (epoch ms), unique per notice. */
  at: number;
}

export interface EditorPresence {
  /** Other staff on this editor now (never the viewer). */
  others: RealtimePresence[];
  /** The last save by someone else since this editor opened, until dismissed. */
  remoteSave: RemoteSave | null;
  dismissRemoteSave(): void;
}

/**
 * Presence and live save notices for one revision-fenced editor. `key` is
 * `presenceKey(prefix, id)`; null turns it off (a new, unsaved record).
 * `currentRev` drops a save notice for a revision this editor already has.
 */
export function useEditorPresence(key: string | null, currentRev?: number | null): EditorPresence {
  const [others, setOthers] = useState<RealtimePresence[]>([]);
  const [remoteSave, setRemoteSave] = useState<RemoteSave | null>(null);
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
      saved: (savedKey, by, savedRev, fields) => {
        if (savedKey !== key) return;
        if (savedRev !== null && rev.current !== null && savedRev <= rev.current) return;
        saveStamp = Math.max(saveStamp + 1, Date.now());
        setRemoteSave({ by, rev: savedRev, fields, at: saveStamp });
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

/** What the presence layer needs of one editor. */
export interface EditorPresenceValue extends EditorPresence {
  presenceKey: string;
  dirty: boolean;
  readOnly?: boolean;
  /** The fields this draft changed (form names), to tell a clean merge from a clash. */
  changedFields?: () => readonly string[];
  /** Loads the latest saved record under this draft's edits (a merge), or simply the latest when clean. */
  onLoadLatest?: () => void;
}
