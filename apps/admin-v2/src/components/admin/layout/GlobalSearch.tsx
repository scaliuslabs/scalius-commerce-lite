import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { GO_SHORTCUTS } from "./AdminNav";
import { typingIn, useShell } from "./shell";
import type { GlobalSearchProps } from "./GlobalSearchDialog";

// cmdk loads in its own chunk after the shell; the dialog itself stays mounted.
const GlobalSearchDialog = lazy(() =>
  import("./GlobalSearchDialog").then((module) => ({ default: module.GlobalSearchDialog })),
);
const ShortcutsDialog = lazy(() =>
  import("./GlobalSearchDialog").then((module) => ({ default: module.ShortcutsDialog })),
);

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** What opens search, for `aria-keyshortcuts` on the buttons that open it too. */
export const SEARCH_KEYS = isMac ? "Meta+K S" : "Control+K S";
const SEQUENCE_MS = 1000;

/**
 * The search and shortcut host, mounted once with the shell; the sidebar's
 * Search field and rail icon open it too. ⌘K / Ctrl+K or S opens it; G then
 * H, O, P, C, D or S jumps to a section (Shopify's sequences); ? lists the
 * shortcuts. Shortcuts never fire while typing.
 */
export function GlobalSearch(props: GlobalSearchProps) {
  const { canOpen } = props;
  const navigate = useNavigate();
  const { searchOpen, setSearchOpen } = useShell();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let goPressedAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen((value) => !value);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target)) return;
      if (Date.now() - goPressedAt < SEQUENCE_MS && GO_SHORTCUTS[key]) {
        goPressedAt = 0;
        const to = GO_SHORTCUTS[key]!;
        if (canOpen(to)) {
          event.preventDefault();
          void navigate({ to });
        }
        return;
      }
      if (key === "g") goPressedAt = Date.now();
      else if (event.key === "?") {
        event.preventDefault();
        setHelpOpen(true);
      } else if (key === "s") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canOpen, navigate, setSearchOpen]);

  return (
    <Suspense fallback={null}>
      <GlobalSearchDialog {...props} open={searchOpen} setOpen={setSearchOpen} />
      <ShortcutsDialog open={helpOpen} setOpen={setHelpOpen} />
    </Suspense>
  );
}
