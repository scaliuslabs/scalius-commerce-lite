import * as React from "react";
import { matchesShortcut, typingIn } from "./shortcuts";

const STORAGE_KEY = "scalius.nav.collapsed";
const DESKTOP = "(min-width: 768px)";

interface Shell {
  /** Desktop: the navigation is the icon rail only (saved per browser). */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Phones: the navigation drawer. */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  searchOpen: boolean;
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** The `?` keyboard shortcuts dialog. */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

const ShellContext = React.createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = React.useContext(ShellContext);
  if (!shell) throw new Error("useShell must be used inside ShellProvider.");
  return shell;
}

function savedCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The navigation's state. The saved expanded/collapsed choice is read before
 * the first render (the dashboard renders only in the browser), so the shell
 * paints in its final shape. ⌘B / Ctrl+B toggles it, never while typing.
 */
export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(savedCollapsed);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((value) => {
      try {
        localStorage.setItem(STORAGE_KEY, value ? "0" : "1");
      } catch {
        // Private mode: the choice lasts for this page only.
      }
      return !value;
    });
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut("navigation", event) || typingIn(event.target)) return;
      event.preventDefault();
      if (window.matchMedia(DESKTOP).matches) toggleCollapsed();
      else setDrawerOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleCollapsed]);

  const shell = React.useMemo<Shell>(
    () => ({ collapsed, toggleCollapsed, drawerOpen, setDrawerOpen, searchOpen, setSearchOpen, helpOpen, setHelpOpen }),
    [collapsed, toggleCollapsed, drawerOpen, searchOpen, helpOpen],
  );
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
}
