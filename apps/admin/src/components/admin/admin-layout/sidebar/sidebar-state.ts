/**
 * Sidebar state management — localStorage persistence, submenu open/close,
 * collapse state, and global sidebar state singleton.
 */

export interface SidebarState {
  globalListenersBound: boolean;
  isCollapsed: boolean;
  scrollTimeout: number | null;
}

export const STORAGE_KEYS = {
  collapsed: "sidebar-collapsed",
  submenus: "sidebar-submenu-states",
  scrollPosition: "sidebar-scroll-position",
} as const;

// ---------------------------------------------------------------------------
// Global singleton — survives Astro view transitions
// ---------------------------------------------------------------------------

const defaultState: SidebarState = {
  globalListenersBound: false,
  isCollapsed: false,
  scrollTimeout: null,
};

export function getSidebarState(): SidebarState {
  if (!window.__adminSidebarState) {
    window.__adminSidebarState = { ...defaultState };
  }
  return window.__adminSidebarState;
}

// ---------------------------------------------------------------------------
// Safe localStorage helpers
// ---------------------------------------------------------------------------

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage write failures.
  }
}

// ---------------------------------------------------------------------------
// Submenu state persistence (JSON serialize / deserialize)
// ---------------------------------------------------------------------------

export function getSavedSubmenuStates(): Record<string, boolean> {
  try {
    return JSON.parse(readStorage(STORAGE_KEYS.submenus) || "{}");
  } catch {
    return {};
  }
}

export function saveSubmenuStates(): void {
  const states: Record<string, boolean> = {};
  document
    .querySelectorAll<HTMLElement>('#desktop-sidebar [data-toggle-submenu="true"]')
    .forEach((toggleButton) => {
      const key = toggleButton.getAttribute("data-submenu-key");
      const submenu = getSubmenuContainer(toggleButton);
      if (key && submenu) {
        states[key] = isSubmenuOpen(submenu);
      }
    });
  writeStorage(STORAGE_KEYS.submenus, JSON.stringify(states));
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

export function getSubmenuContainer(toggleButton: HTMLElement): HTMLElement | null {
  return toggleButton.parentElement?.querySelector<HTMLElement>(".submenu-container") ?? null;
}

export function getSubmenuChevron(toggleButton: HTMLElement): HTMLElement | null {
  return toggleButton.querySelector<HTMLElement>(".submenu-chevron") ?? null;
}

// ---------------------------------------------------------------------------
// Submenu open / close
// ---------------------------------------------------------------------------

export function isSubmenuOpen(submenu: HTMLElement | null): boolean {
  if (!submenu) return false;
  return !submenu.classList.contains("hidden") && submenu.style.maxHeight !== "0px";
}

/**
 * Animated open/close with maxHeight transition + chevron rotation.
 * Bug fix: timeout aligned from 300ms to 350ms to match CSS transition duration.
 */
export function setSubmenuOpen(
  toggleButton: HTMLElement,
  shouldOpen: boolean,
  save = true,
): void {
  const submenu = getSubmenuContainer(toggleButton);
  const chevron = getSubmenuChevron(toggleButton);

  if (!submenu) return;

  if (shouldOpen) {
    submenu.classList.remove("hidden");
    submenu.style.maxHeight = `${submenu.scrollHeight}px`;
    chevron?.classList.add("rotate-180");
  } else {
    submenu.style.maxHeight = "0px";
    chevron?.classList.remove("rotate-180");
    window.setTimeout(() => {
      if (submenu.style.maxHeight === "0px") {
        submenu.classList.add("hidden");
      }
    }, 350);
  }

  toggleButton.setAttribute("aria-expanded", shouldOpen ? "true" : "false");

  if (save) {
    saveSubmenuStates();
  }
}

/** Instant version for initialization — no CSS animation. */
export function setSubmenuOpenInstant(
  toggleButton: HTMLElement,
  shouldOpen: boolean,
): void {
  const submenu = getSubmenuContainer(toggleButton);
  const chevron = getSubmenuChevron(toggleButton);
  if (!submenu) return;
  if (shouldOpen) {
    submenu.classList.remove("hidden");
    submenu.style.maxHeight = `${submenu.scrollHeight}px`;
    chevron?.classList.add("rotate-180");
  } else {
    submenu.style.maxHeight = "0px";
    submenu.classList.add("hidden");
    chevron?.classList.remove("rotate-180");
  }
  toggleButton.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

/** Recalculate maxHeight for all open submenus. */
export function syncOpenSubmenuHeights(): void {
  document
    .querySelectorAll<HTMLElement>('[data-toggle-submenu="true"]')
    .forEach((toggleButton) => {
      const submenu = getSubmenuContainer(toggleButton);
      if (submenu && isSubmenuOpen(submenu)) {
        submenu.style.maxHeight = `${submenu.scrollHeight}px`;
      }
    });
}

// ---------------------------------------------------------------------------
// Sidebar collapse
// ---------------------------------------------------------------------------

export function setSidebarCollapsed(shouldCollapse: boolean, save = true): void {
  const desktopSidebarEl = document.getElementById("desktop-sidebar");
  if (!desktopSidebarEl) return;

  const sidebarState = getSidebarState();
  sidebarState.isCollapsed = shouldCollapse;
  document.body.classList.remove("sidebar-pre-collapsed");

  if (shouldCollapse) {
    desktopSidebarEl.style.width = "60px";
    desktopSidebarEl.classList.add("sidebar-collapsed");
  } else {
    desktopSidebarEl.style.width = "240px";
    desktopSidebarEl.classList.remove("sidebar-collapsed");
  }

  document.documentElement.style.setProperty(
    "--sidebar-width",
    shouldCollapse ? "60px" : "240px",
  );

  if (save) {
    writeStorage(STORAGE_KEYS.collapsed, shouldCollapse.toString());
  }

  requestAnimationFrame(syncOpenSubmenuHeights);
}

export function toggleSidebarCollapse(): void {
  setSidebarCollapsed(!getSidebarState().isCollapsed);
}
