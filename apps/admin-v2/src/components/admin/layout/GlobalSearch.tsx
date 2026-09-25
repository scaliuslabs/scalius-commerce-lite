import { lazy, Suspense, useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { GO_KEY, goKeys, matchesShortcut, SEQUENCE_MS, typingIn } from "./shortcuts";
import { useStaffShortcuts } from "./staff-shortcuts";
import { useShell } from "./shell";
import type { GlobalSearchProps } from "./GlobalSearchDialog";

// cmdk loads in its own chunk after the shell; the dialogs themselves stay mounted.
const GlobalSearchDialog = lazy(() =>
  import("./GlobalSearchDialog").then((module) => ({ default: module.GlobalSearchDialog })),
);
const ShortcutsDialog = lazy(() =>
  import("./ShortcutsDialog").then((module) => ({ default: module.ShortcutsDialog })),
);

/**
 * The search and shortcut host, mounted once with the shell; the top bar's
 * search field and help button open its dialogs too. Keys come from the
 * shortcut registry: ⌘K / Ctrl+K or S opens search, ? lists every shortcut,
 * and G then a letter goes to a page (the defaults plus this staff member's
 * own choices). Nothing fires while typing.
 */
export function GlobalSearch(props: Omit<GlobalSearchProps, "goKeys">) {
  const { canOpen } = props;
  const navigate = useNavigate();
  const { searchOpen, setSearchOpen, helpOpen, setHelpOpen } = useShell();
  const shortcuts = useStaffShortcuts();
  const keys = useMemo(() => goKeys(shortcuts.data?.shortcuts), [shortcuts.data]);
  const destinations = useMemo(() => new Map([...keys].map(([to, key]) => [key, to])), [keys]);

  useEffect(() => {
    let goPressedAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut("search", event) && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen((value) => !value);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target)) return;
      const key = event.key.toLowerCase();
      const to = destinations.get(key);
      if (Date.now() - goPressedAt < SEQUENCE_MS && to) {
        goPressedAt = 0;
        if (canOpen(to)) {
          event.preventDefault();
          void navigate({ to });
        }
        return;
      }
      if (key === GO_KEY) goPressedAt = Date.now();
      else if (matchesShortcut("help", event)) {
        event.preventDefault();
        setHelpOpen(true);
      } else if (matchesShortcut("search", event)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canOpen, navigate, setSearchOpen, setHelpOpen, destinations]);

  return (
    <Suspense fallback={null}>
      <GlobalSearchDialog {...props} goKeys={keys} open={searchOpen} setOpen={setSearchOpen} />
      <ShortcutsDialog {...props} open={helpOpen} setOpen={setHelpOpen} />
    </Suspense>
  );
}
