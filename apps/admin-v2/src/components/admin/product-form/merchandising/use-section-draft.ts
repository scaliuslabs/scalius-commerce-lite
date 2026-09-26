import { useCallback, useEffect, useRef, useState } from "react";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A section's draft beside its saved value. A fresh read replaces the draft
 * only while it has no edits; `markSaved` takes what a save sent as the new
 * saved value, so edits typed during the save stay unsaved.
 */
export function useSectionDraft<T>(loaded: T | undefined) {
  const [saved, setSaved] = useState<T | undefined>(loaded);
  const [draft, setDraft] = useState<T | undefined>(loaded);
  const dirty = draft !== undefined && saved !== undefined && !same(draft, saved);
  const current = useRef({ saved, dirty });
  current.current = { saved, dirty };

  useEffect(() => {
    if (loaded === undefined || current.current.dirty) return;
    setSaved(loaded);
    setDraft(loaded);
  }, [loaded]);

  const markSaved = useCallback((value: T) => setSaved(value), []);
  // Check without changing state: the whole page must pass before any baseline moves.
  const prepareRebase = useCallback((latest: T): (() => void) | null => {
    const state = current.current;
    if (state.dirty && !same(state.saved, latest)) return null;
    return () => {
      setSaved(latest);
      if (!current.current.dirty) setDraft(latest);
    };
  }, []);
  const discard = useCallback(() => setDraft(saved), [saved]);
  return { draft, setDraft, saved, dirty, markSaved, discard, prepareRebase };
}
