// src/components/product/scripts/product-tabs.ts
/**
 * Product Details Tabs Controller
 */

interface TabElements {
  buttons: NodeListOf<HTMLElement>;
  panels: NodeListOf<HTMLElement>;
  nav: HTMLElement | null;
  scrollLeftBtn: HTMLElement | null;
  scrollRightBtn: HTMLElement | null;
  fadeLeft: HTMLElement | null;
  fadeRight: HTMLElement | null;
}

let elements: TabElements | null = null;

export function init(): void {
  elements = {
    buttons: document.querySelectorAll('[role="tab"]'),
    panels: document.querySelectorAll('[role="tabpanel"]'),
    nav: document.getElementById("tab-nav"),
    scrollLeftBtn: document.getElementById("scroll-left"),
    scrollRightBtn: document.getElementById("scroll-right"),
    fadeLeft: document.getElementById("fade-left"),
    fadeRight: document.getElementById("fade-right"),
  };

  if (!elements.panels.length) return;

  initTabSwitching();
  initScrollNavigation();
  initKeyboardNavigation();
}

function switchTab(targetTabId: string): void {
  if (!elements) return;

  // Update button states
  elements.buttons.forEach((button) => {
    const tabId = button.dataset.tabId;
    const isActive = tabId === targetTabId;

    button.setAttribute("aria-selected", isActive ? "true" : "false");

    if (isActive) {
      button.classList.remove("border-transparent", "text-gray-500");
      button.classList.add("border-primary", "text-primary");

      // Scroll active tab into view
      if (elements?.nav) {
        button.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
      }
    } else {
      button.classList.remove("border-primary", "text-primary");
      button.classList.add("border-transparent", "text-gray-500");
    }
  });

  // Update panel visibility
  elements.panels.forEach((panel) => {
    const panelId = panel.dataset.tabPanel;
    if (panelId === targetTabId) {
      panel.classList.remove("hidden");
    } else {
      panel.classList.add("hidden");
    }
  });
}

function initTabSwitching(): void {
  if (!elements) return;

  elements.buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = button.dataset.tabId;
      if (tabId) switchTab(tabId);
    });
  });
}

function updateScrollUI(): void {
  if (!elements?.nav || !elements.fadeLeft || !elements.fadeRight) return;

  const { scrollLeft, scrollWidth, clientWidth } = elements.nav;
  const canScrollLeft = scrollLeft > 0;
  const canScrollRight = scrollLeft < scrollWidth - clientWidth - 10;

  // Update fade indicators
  elements.fadeLeft.style.opacity = canScrollLeft ? "1" : "0";
  elements.fadeRight.style.opacity = canScrollRight ? "1" : "0";

  // Update scroll buttons
  if (elements.scrollLeftBtn) {
    elements.scrollLeftBtn.style.opacity = canScrollLeft ? "0.7" : "0";
  }
  if (elements.scrollRightBtn) {
    elements.scrollRightBtn.style.opacity = canScrollRight ? "0.7" : "0";
  }
}

function initScrollNavigation(): void {
  if (!elements) return;

  // Scroll left button
  if (elements.scrollLeftBtn && elements.nav) {
    elements.scrollLeftBtn.addEventListener("click", () => {
      elements?.nav?.scrollBy({ left: -200, behavior: "smooth" });
    });
  }

  // Scroll right button
  if (elements.scrollRightBtn && elements.nav) {
    elements.scrollRightBtn.addEventListener("click", () => {
      elements?.nav?.scrollBy({ left: 200, behavior: "smooth" });
    });
  }

  // Update scroll UI on scroll
  if (elements.nav) {
    elements.nav.addEventListener("scroll", updateScrollUI, { passive: true });

    // Initial check - use requestAnimationFrame for better performance
    requestAnimationFrame(() => {
      setTimeout(updateScrollUI, 50);
    });

    // Update on window resize - debounce for performance
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
}

function initKeyboardNavigation(): void {
  if (!elements) return;

  elements.buttons.forEach((button, index) => {
    button.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      const buttons = Array.from(elements!.buttons);

      let targetIndex = index;

      if (key === "ArrowLeft") {
        e.preventDefault();
        targetIndex = index > 0 ? index - 1 : buttons.length - 1;
      } else if (key === "ArrowRight") {
        e.preventDefault();
        targetIndex = index < buttons.length - 1 ? index + 1 : 0;
      } else {
        return;
      }

      const targetButton = buttons[targetIndex];
      targetButton.focus();

      const tabId = targetButton.dataset.tabId;
      if (tabId) switchTab(tabId);
    });
  });
}

// AUTO-INITIALIZE

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
