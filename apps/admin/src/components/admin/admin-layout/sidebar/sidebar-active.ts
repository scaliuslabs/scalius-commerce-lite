/**
 * Sidebar active-state detection — path matching, active class application,
 * and submenu restoration based on current URL.
 */

import {
  getSavedSubmenuStates,
  setSubmenuOpenInstant,
} from "./sidebar-state";

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

function getCurrentPath(): string {
  return window.location.pathname;
}

/** Exact pathname comparison. */
export function isExactPathMatch(targetPath: string): boolean {
  return getCurrentPath() === targetPath;
}

/**
 * Prefix matching with special case: `/admin` is exact-only.
 * Bug fix: both mobile and desktop now use this unified function.
 */
export function isPrefixPathMatch(targetPath: string): boolean {
  const currentPath = getCurrentPath();
  if (targetPath === "/admin") {
    return currentPath === targetPath;
  }
  return currentPath === targetPath || currentPath.startsWith(`${targetPath}/`);
}

// ---------------------------------------------------------------------------
// Parent / sub-item activity checks
// ---------------------------------------------------------------------------

/** Check if any subitems of a parent match the current path. */
export function parentContainsActiveSubItem(toggleButton: HTMLElement): boolean {
  return Array.from(
    toggleButton.parentElement?.querySelectorAll<HTMLElement>("[data-sidebar-subitem]") || [],
  ).some((subItem) => isExactPathMatch(subItem.getAttribute("data-sidebar-item-href") ?? ""));
}

/** Check if a parent nav item or any of its children are active. */
export function isParentItemActive(toggleButton: HTMLElement): boolean {
  const itemHref = toggleButton.getAttribute("data-href");
  if (!itemHref) return false;
  return isPrefixPathMatch(itemHref) || parentContainsActiveSubItem(toggleButton);
}

// ---------------------------------------------------------------------------
// Apply active states to all sidebar links
// ---------------------------------------------------------------------------

/**
 * Set `.is-active` class and `aria-current="page"` on all links and parents.
 * Auto-closes submenus whose parent is no longer active.
 */
export function applyActiveStates(): void {
  document.querySelectorAll<HTMLElement>("[data-sidebar-link]").forEach((link) => {
    const href = link.getAttribute("data-sidebar-item-href");
    const isActive = href ? isPrefixPathMatch(href) : false;
    link.classList.toggle("is-active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  document.querySelectorAll<HTMLElement>("[data-sidebar-subitem]").forEach((link) => {
    const href = link.getAttribute("data-sidebar-item-href");
    const isActive = href ? isExactPathMatch(href) : false;
    link.classList.toggle("is-active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  document.querySelectorAll<HTMLElement>("[data-sidebar-parent]").forEach((toggleButton) => {
    const isActive = isParentItemActive(toggleButton);
    toggleButton.classList.toggle("is-active", isActive);
    // Auto-close submenu when navigating away from its section
    if (!isActive) {
      setSubmenuOpenInstant(toggleButton, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Restore submenu states from saved + active path
// ---------------------------------------------------------------------------

/** Opens submenus based on active path + saved localStorage state. */
export function restoreSubmenuStates(): void {
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
      // Use instant (no-animation) version to avoid jump during initialization
      setSubmenuOpenInstant(toggleButton, shouldOpen);
    });
}
