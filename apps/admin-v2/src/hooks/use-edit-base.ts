import { useCallback, useState } from "react";

/**
 * The version an edit is made against. While the form is clean it follows
 * the latest read; once it holds unsaved edits it keeps the value it had when
 * the edit began, so a live refetch never moves the version a save asserts
 * (the server then refuses a save that met another one, instead of the save
 * overwriting it). `moved`: the latest read differs from it, someone else
 * saved under the edit. `rebase` takes the latest as the base ("keep mine").
 */
export function useEditBase<T>(latest: T, dirty: boolean, same: (a: T, b: T) => boolean = Object.is): {
  base: T;
  moved: boolean;
  rebase: () => void;
} {
  const [pinned, setPinned] = useState(latest);
  // Clean: the base follows the read (a render-time update of this hook's own state).
  if (!dirty && !same(pinned, latest)) setPinned(latest);
  const base = dirty ? pinned : latest;
  const rebase = useCallback(() => setPinned(latest), [latest]);
  return { base, moved: dirty && !same(pinned, latest), rebase };
}
