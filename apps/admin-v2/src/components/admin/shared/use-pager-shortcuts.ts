import { useEffect, useRef } from "react";
import { matchesShortcut, typingIn } from "~/components/admin/layout/shortcuts";

/**
 * J and K step to the previous and next record of the list the page came
 * from (Polaris pagination's keys), never while typing or in a dialog. A
 * go-to sequence the shell already handled (G then J) wins.
 */
export function usePagerShortcuts(go: { previous: (() => void) | null; next: (() => void) | null }) {
  const latest = useRef(go);
  latest.current = go;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || typingIn(event.target)) return;
      const action = matchesShortcut("previousItem", event)
        ? latest.current.previous
        : matchesShortcut("nextItem", event) ? latest.current.next : null;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
