import { useEffect, useRef } from "react";
import { GO_KEY, SEQUENCE_MS, typingIn } from "../layout/shortcuts";

/** Keep page actions out of input, IME, menus, and the shell's configurable G sequences. */
export function createInboxShortcutGuard() {
  let goUntil = 0;
  return (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
      || event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target)
      || (event.target instanceof Element && event.target.closest('[role="menu"], [role="listbox"], [role="combobox"]'))
      || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return false;
    if (event.key.toLowerCase() === GO_KEY) { goUntil = Date.now() + SEQUENCE_MS; return false; }
    if (Date.now() < goUntil) { goUntil = 0; return false; }
    return true;
  };
}

export function useInboxShortcuts(handler: (event: KeyboardEvent) => void, active: boolean) {
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => {
    if (!active) return;
    const allowed = createInboxShortcutGuard();
    const listener = (event: KeyboardEvent) => { if (allowed(event)) current.current(event); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [active]);
}
