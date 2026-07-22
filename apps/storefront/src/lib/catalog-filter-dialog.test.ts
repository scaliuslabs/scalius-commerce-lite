// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCatalogFilterDialog } from "./catalog-filter-dialog";

describe("catalog filter dialog", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="mobile-filter-toggle" aria-controls="filter-section" aria-expanded="false">Filters</button>
      <aside id="filter-section" class="hidden" aria-labelledby="mobile-filter-title">
        <h2 id="mobile-filter-title">Filters</h2>
        <button id="mobile-filter-close" aria-label="Close filters">Close</button>
        <input aria-label="Filter value" />
      </aside>
    `;
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(max-width: 1023px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("opens as a modal, traps focus, closes on Escape, and restores focus", () => {
    setupCatalogFilterDialog();
    const toggle = document.querySelector<HTMLButtonElement>(
      "#mobile-filter-toggle",
    )!;
    const dialog = document.querySelector<HTMLElement>("#filter-section")!;
    const close = document.querySelector<HTMLButtonElement>(
      "#mobile-filter-close",
    )!;
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Filter value"]',
    )!;

    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-hidden")).toBe("true");

    toggle.click();
    expect(dialog.classList.contains("hidden")).toBe(false);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(close);

    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(document.activeElement).toBe(close);

    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(dialog.classList.contains("hidden")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("supports collection-specific control IDs", () => {
    document.body.innerHTML = `
      <button id="collection-toggle" aria-expanded="false">Filters</button>
      <aside id="collection-dialog" class="hidden">
        <button id="collection-close">Close</button>
      </aside>
    `;

    setupCatalogFilterDialog({
      toggleId: "collection-toggle",
      closeId: "collection-close",
      dialogId: "collection-dialog",
    });

    const toggle =
      document.querySelector<HTMLButtonElement>("#collection-toggle")!;
    const dialog = document.querySelector<HTMLElement>("#collection-dialog")!;
    toggle.click();

    expect(dialog.classList.contains("hidden")).toBe(false);
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(document.activeElement?.id).toBe("collection-close");
  });

  it("restores the page's existing overflow style after closing", () => {
    document.body.style.overflow = "clip";
    setupCatalogFilterDialog();

    document.querySelector<HTMLButtonElement>("#mobile-filter-toggle")!.click();
    expect(document.body.style.overflow).toBe("hidden");

    document.querySelector<HTMLButtonElement>("#mobile-filter-close")!.click();
    expect(document.body.style.overflow).toBe("clip");
  });
});
