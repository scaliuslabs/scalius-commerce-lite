// src/components/product/scripts/product-tabs.ts

interface TabElements {
  root: HTMLElement;
  buttons: HTMLButtonElement[];
  panels: HTMLElement[];
  nav: HTMLElement | null;
  scrollLeftBtn: HTMLElement | null;
  scrollRightBtn: HTMLElement | null;
  fadeLeft: HTMLElement | null;
  fadeRight: HTMLElement | null;
}

let elements: TabElements | null = null;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

function tabFromHash(): string | null {
  let hash: string;
  try {
    hash = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return null;
  }
  if (!hash.startsWith("details-panel-")) return null;
  return hash.slice("details-panel-".length) || null;
}

function setTabHash(button: HTMLButtonElement): void {
  const anchor = button.dataset.tabAnchor;
  if (!anchor || window.location.hash === `#${anchor}`) return;

  const url = new URL(window.location.href);
  url.hash = anchor;
  window.history.replaceState(window.history.state, "", url);
}

function centerTabInNav(button: HTMLButtonElement): void {
  if (!elements?.nav) return;

  const left = button.offsetLeft - (elements.nav.clientWidth - button.clientWidth) / 2;
  elements.nav.scrollTo({ left: Math.max(0, left), behavior: scrollBehavior() });
}

function switchTab(
  targetTabId: string,
  options: { updateHash?: boolean; scrollPanel?: boolean } = {},
): void {
  if (!elements) return;

  const activeButton = elements.buttons.find(
    (button) => button.dataset.tabId === targetTabId,
  );
  const activePanel = elements.panels.find(
    (panel) => panel.dataset.tabPanel === targetTabId,
  );
  if (!activeButton || !activePanel) return;

  elements.buttons.forEach((button) => {
    const isActive = button === activeButton;
    button.setAttribute("aria-selected", isActive ? "true" : "false");
    button.tabIndex = isActive ? 0 : -1;
    button.classList.toggle("border-primary", isActive);
    button.classList.toggle("text-primary", isActive);
    button.classList.toggle("border-transparent", !isActive);
    button.classList.toggle("text-gray-500", !isActive);
    button.classList.toggle("hover:border-gray-300", !isActive);
    button.classList.toggle("hover:text-gray-700", !isActive);
  });

  elements.panels.forEach((panel) => {
    panel.classList.toggle("hidden", panel !== activePanel);
  });

  centerTabInNav(activeButton);
  if (options.updateHash) setTabHash(activeButton);

  if (options.scrollPanel) {
    requestAnimationFrame(() => {
      activePanel.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    });
  }
}

function initTabSwitching(): void {
  if (!elements) return;

  elements.buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = button.dataset.tabId;
      if (tabId) switchTab(tabId, { updateHash: true });
    });
  });

  window.addEventListener("hashchange", () => {
    const tabId = tabFromHash();
    if (tabId) switchTab(tabId, { scrollPanel: true });
  });
}

function updateScrollUI(): void {
  if (!elements?.nav || !elements.fadeLeft || !elements.fadeRight) return;

  const { scrollLeft, scrollWidth, clientWidth } = elements.nav;
  const canScrollLeft = scrollLeft > 0;
  const canScrollRight = scrollLeft < scrollWidth - clientWidth - 10;

  elements.fadeLeft.style.opacity = canScrollLeft ? "1" : "0";
  elements.fadeRight.style.opacity = canScrollRight ? "1" : "0";

  if (elements.scrollLeftBtn) {
    elements.scrollLeftBtn.style.opacity = canScrollLeft ? "0.7" : "0";
  }
  if (elements.scrollRightBtn) {
    elements.scrollRightBtn.style.opacity = canScrollRight ? "0.7" : "0";
  }
}

function initScrollNavigation(): void {
  if (!elements) return;

  elements.scrollLeftBtn?.addEventListener("click", () => {
    elements?.nav?.scrollBy({ left: -200, behavior: scrollBehavior() });
  });
  elements.scrollRightBtn?.addEventListener("click", () => {
    elements?.nav?.scrollBy({ left: 200, behavior: scrollBehavior() });
  });

  if (!elements.nav) return;
  elements.nav.addEventListener("scroll", updateScrollUI, { passive: true });

  requestAnimationFrame(updateScrollUI);
  let resizeTimeout: ReturnType<typeof setTimeout>;
  window.addEventListener(
    "resize",
    () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(updateScrollUI, 100);
    },
    { passive: true },
  );
}

function initKeyboardNavigation(): void {
  if (!elements) return;

  elements.buttons.forEach((button, index) => {
    button.addEventListener("keydown", (event) => {
      const buttons = elements?.buttons ?? [];
      let targetIndex: number | null = null;

      if (event.key === "ArrowLeft") {
        targetIndex = index > 0 ? index - 1 : buttons.length - 1;
      } else if (event.key === "ArrowRight") {
        targetIndex = index < buttons.length - 1 ? index + 1 : 0;
      } else if (event.key === "Home") {
        targetIndex = 0;
      } else if (event.key === "End") {
        targetIndex = buttons.length - 1;
      }

      if (targetIndex === null) return;
      event.preventDefault();

      const targetButton = buttons[targetIndex];
      const tabId = targetButton?.dataset.tabId;
      if (!targetButton || !tabId) return;

      targetButton.focus();
      switchTab(tabId, { updateHash: true });
    });
  });
}

export function init(): void {
  const root = document.querySelector<HTMLElement>("[data-product-details-tabs]");
  if (!root || root.dataset.tabsInitialized === "true") return;

  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
  if (!buttons.length || !panels.length) return;

  root.dataset.tabsInitialized = "true";
  elements = {
    root,
    buttons,
    panels,
    nav: root.querySelector("#tab-nav"),
    scrollLeftBtn: root.querySelector("#scroll-left"),
    scrollRightBtn: root.querySelector("#scroll-right"),
    fadeLeft: root.querySelector("#fade-left"),
    fadeRight: root.querySelector("#fade-right"),
  };

  initTabSwitching();
  initScrollNavigation();
  initKeyboardNavigation();

  const hashTab = tabFromHash();
  const initialTab = hashTab && buttons.some((button) => button.dataset.tabId === hashTab)
    ? hashTab
    : buttons.find((button) => button.getAttribute("aria-selected") === "true")?.dataset.tabId;
  if (initialTab) switchTab(initialTab, { scrollPanel: Boolean(hashTab) });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
