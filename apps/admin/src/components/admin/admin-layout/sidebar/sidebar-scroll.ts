/**
 * Sidebar scroll persistence — save/restore scroll position and
 * auto-scroll after Settings submenu expansion.
 */

import { STORAGE_KEYS, readStorage, writeStorage, getSubmenuContainer } from "./sidebar-state";

// ---------------------------------------------------------------------------
// Scroll position persistence
// ---------------------------------------------------------------------------

function getSidebarNav(): HTMLElement | null {
  return document.getElementById("sidebar-nav");
}

/** Save sidebar nav scroll position to localStorage. */
export function saveScrollPosition(): void {
  const sidebarNavEl = getSidebarNav();
  if (!sidebarNavEl) return;
  writeStorage(STORAGE_KEYS.scrollPosition, sidebarNavEl.scrollTop.toString());
}

/** Restore synchronously — no rAF, no smooth scroll — prevents visible jump. */
export function restoreScrollPosition(): void {
  const sidebarNavEl = getSidebarNav();
  const scrollPosition = readStorage(STORAGE_KEYS.scrollPosition);
  if (!sidebarNavEl || !scrollPosition) return;
  sidebarNavEl.scrollTop = Number.parseInt(scrollPosition, 10) || 0;
}

// ---------------------------------------------------------------------------
// Settings submenu reveal
// ---------------------------------------------------------------------------

/** Auto-scroll after Settings expand to ensure last sub-item is visible. */
export function revealSettingsSubmenu(toggleButton: HTMLElement): void {
  const sidebarNavEl = getSidebarNav();
  const submenu = getSubmenuContainer(toggleButton);

  if (!sidebarNavEl || !submenu || !toggleButton.closest("#desktop-sidebar")) return;

  // Wait for the max-height CSS transition (350ms) to finish before measuring
  window.setTimeout(() => {
    const lastSubItem = submenu.lastElementChild;
    if (!lastSubItem) return;
    const navRect = sidebarNavEl.getBoundingClientRect();
    const itemRect = lastSubItem.getBoundingClientRect();
    const bottomPadding = 16;
    if (itemRect.bottom > navRect.bottom - bottomPadding) {
      sidebarNavEl.scrollBy({
        top: itemRect.bottom - (navRect.bottom - bottomPadding),
        behavior: "smooth",
      });
    }
  }, 360);
}
