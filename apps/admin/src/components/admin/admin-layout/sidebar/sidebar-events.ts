/**
 * Sidebar event binding — submenu toggles, scroll persistence, global
 * listeners (Astro lifecycle, custom events), mobile sidebar, and
 * main initialization orchestrator.
 */

import {
  STORAGE_KEYS,
  readStorage,
  getSidebarState,
  isSubmenuOpen,
  getSubmenuContainer,
  getSavedSubmenuStates,
  setSubmenuOpen,
  setSubmenuOpenInstant,
  setSidebarCollapsed,
  toggleSidebarCollapse,
  syncOpenSubmenuHeights,
  saveSubmenuStates,
} from "./sidebar-state";
import { applyActiveStates, isParentItemActive, restoreSubmenuStates } from "./sidebar-active";
import { saveScrollPosition, restoreScrollPosition, revealSettingsSubmenu } from "./sidebar-scroll";

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function getDesktopSidebar(): HTMLElement | null {
  return document.getElementById("desktop-sidebar");
}

function getMobileSidebar(): HTMLElement | null {
  return document.getElementById("mobile-sidebar");
}

function getSidebarOverlay(): HTMLElement | null {
  return document.getElementById("sidebar-overlay");
}

function getCloseSidebarButton(): HTMLElement | null {
  return document.getElementById("close-sidebar");
}

function getSidebarNav(): HTMLElement | null {
  return document.getElementById("sidebar-nav");
}

// ---------------------------------------------------------------------------
// Mobile sidebar
// ---------------------------------------------------------------------------

export function toggleMobileSidebar(): void {
  getMobileSidebar()?.classList.toggle("-translate-x-full");
  getSidebarOverlay()?.classList.toggle("opacity-0");
  getSidebarOverlay()?.classList.toggle("pointer-events-none");
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

/** Click delegation for submenu toggle buttons. */
function bindSubmenuToggleHandlers(rootElement: HTMLElement | null): void {
  if (!rootElement || (rootElement as HTMLElement & { dataset: DOMStringMap }).dataset.sidebarBound === "true") return;

  rootElement.addEventListener("click", (event: Event) => {
    const toggleButton = (event.target as HTMLElement).closest<HTMLElement>('[data-toggle-submenu="true"]');
    if (!toggleButton || !rootElement.contains(toggleButton)) return;

    const isSettings = toggleButton.getAttribute("data-is-settings") === "true";
    const sidebarState = getSidebarState();

    if (toggleButton.closest("#desktop-sidebar") && sidebarState.isCollapsed) {
      setSidebarCollapsed(false);
      setSubmenuOpen(toggleButton, true);
    } else {
      const submenu = getSubmenuContainer(toggleButton);
      setSubmenuOpen(toggleButton, !isSubmenuOpen(submenu));
    }

    if (isSettings) {
      revealSettingsSubmenu(toggleButton);
    }
  });

  rootElement.dataset.sidebarBound = "true";
}

/** Scroll event listener with 150ms debounce. */
function bindScrollPersistence(): void {
  const sidebarNavEl = getSidebarNav();
  if (!sidebarNavEl || sidebarNavEl.dataset.scrollBound === "true") return;

  sidebarNavEl.addEventListener("scroll", () => {
    const sidebarState = getSidebarState();
    if (sidebarState.scrollTimeout !== null) {
      window.clearTimeout(sidebarState.scrollTimeout);
    }
    sidebarState.scrollTimeout = window.setTimeout(saveScrollPosition, 150) as unknown as number;
  });

  sidebarNavEl.dataset.scrollBound = "true";
}

/** Bind a static control (overlay, close button) to a handler. */
function bindStaticControl(control: HTMLElement | null, handler: () => void): void {
  if (!control || control.dataset.bound === "true") return;
  control.addEventListener("click", handler);
  control.dataset.bound = "true";
}

/**
 * Custom events (toggleMobileSidebar, toggleSidebarCollapse),
 * Astro lifecycle hooks (before-swap, after-swap, page-load),
 * and beforeunload.
 */
function bindGlobalListeners(): void {
  const sidebarState = getSidebarState();
  if (sidebarState.globalListenersBound) return;

  window.addEventListener("toggleMobileSidebar", toggleMobileSidebar);
  window.addEventListener("toggleSidebarCollapse", toggleSidebarCollapse);
  window.addEventListener("beforeunload", () => {
    saveSubmenuStates();
    saveScrollPosition();
  });

  // Save state RIGHT BEFORE Astro swaps the DOM
  document.addEventListener("astro:before-swap", () => {
    saveSubmenuStates();
    saveScrollPosition();
  });

  // Restore state RIGHT AFTER the DOM swap, before the browser paints
  document.addEventListener("astro:after-swap", () => {
    const sidebarNavEl = getSidebarNav();
    if (!sidebarNavEl) return;

    // Instantly restore scroll position (no animation, no rAF)
    const scrollPos = readStorage(STORAGE_KEYS.scrollPosition);
    if (scrollPos) {
      sidebarNavEl.scrollTop = Number.parseInt(scrollPos, 10) || 0;
    }

    // Instantly sync submenu open/close states without animation
    const savedStates = getSavedSubmenuStates();
    document
      .querySelectorAll<HTMLElement>('[data-toggle-submenu="true"]')
      .forEach((toggleButton) => {
        const key = toggleButton.getAttribute("data-submenu-key");
        const storedState =
          key && Object.prototype.hasOwnProperty.call(savedStates, key)
            ? Boolean(savedStates[key])
            : false;
        const shouldOpen = isParentItemActive(toggleButton) || storedState;
        setSubmenuOpenInstant(toggleButton, shouldOpen);
      });
  });

  // Update active styles after load is complete
  document.addEventListener("astro:page-load", () => {
    applyActiveStates();
    syncOpenSubmenuHeights();
  });

  sidebarState.globalListenersBound = true;
}

// ---------------------------------------------------------------------------
// Main initialization
// ---------------------------------------------------------------------------

/** Orchestrates all sidebar modules. */
export function initializeSidebar(): void {
  const desktopSidebarEl = getDesktopSidebar();
  const sidebarState = getSidebarState();

  sidebarState.isCollapsed = readStorage(STORAGE_KEYS.collapsed) === "true";
  setSidebarCollapsed(sidebarState.isCollapsed, false);

  bindSubmenuToggleHandlers(desktopSidebarEl);
  bindSubmenuToggleHandlers(getMobileSidebar());
  bindStaticControl(getSidebarOverlay(), toggleMobileSidebar);
  bindStaticControl(getCloseSidebarButton(), toggleMobileSidebar);
  bindScrollPersistence();
  bindGlobalListeners();

  if (desktopSidebarEl && desktopSidebarEl.dataset.sidebarInitialized !== "true") {
    restoreSubmenuStates();
    restoreScrollPosition();
    desktopSidebarEl.dataset.sidebarInitialized = "true";
  }

  applyActiveStates();
  syncOpenSubmenuHeights();
}

// ---------------------------------------------------------------------------
// Auto-invoke
// ---------------------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeSidebar, { once: true });
} else {
  requestAnimationFrame(initializeSidebar);
}
