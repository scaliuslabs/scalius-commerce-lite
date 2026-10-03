// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hideCheckoutLoadingOverlay,
  showCheckoutLoadingOverlay,
  SLOW_REDIRECT_AFTER_MS,
} from "./loading-overlay";

describe("checkout loading overlay", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main><button id="pay">Pay</button></main>
      <div id="loadingOverlay" class="hidden" aria-hidden="true" tabindex="-1">
        <h2 id="loadingTitle"></h2>
        <p id="loadingMsg"></p>
      </div>
    `;
    document.body.style.overflow = "auto";
    document.getElementById("pay")?.focus();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("announces processing, blocks background scrolling, and restores focus", () => {
    showCheckoutLoadingOverlay({
      title: "Opening secure payment",
      message: "You'll continue with the selected payment provider.",
    });

    const overlay = document.getElementById("loadingOverlay");
    expect(overlay?.classList.contains("flex")).toBe(true);
    expect(overlay?.classList.contains("hidden")).toBe(false);
    expect(overlay?.getAttribute("aria-hidden")).toBe("false");
    expect(document.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(overlay);
    expect(document.getElementById("loadingTitle")?.textContent).toBe(
      "Opening secure payment",
    );

    hideCheckoutLoadingOverlay();

    expect(overlay?.classList.contains("hidden")).toBe(true);
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector("main")?.hasAttribute("aria-busy")).toBe(false);
    expect(document.body.style.overflow).toBe("auto");
    expect(document.activeElement).toBe(document.getElementById("pay"));
  });

  it("tells the buyer a slow redirect is still on its way, and only while the overlay is up", () => {
    vi.useFakeTimers();
    try {
      showCheckoutLoadingOverlay({
        title: "Opening bKash",
        message: "You'll leave this store to pay with bKash.",
        slowMessage: "Still opening bKash.",
      });
      const message = document.getElementById("loadingMsg");
      vi.advanceTimersByTime(SLOW_REDIRECT_AFTER_MS - 1);
      expect(message?.textContent).toBe("You'll leave this store to pay with bKash.");
      vi.advanceTimersByTime(1);
      expect(message?.textContent).toBe("Still opening bKash.");

      // Hidden (a refusal, an error): the pending message is dropped.
      showCheckoutLoadingOverlay({ title: "Opening bKash", message: "Leaving", slowMessage: "Still opening" });
      hideCheckoutLoadingOverlay();
      vi.advanceTimersByTime(SLOW_REDIRECT_AFTER_MS);
      expect(message?.textContent).toBe("Leaving");

      // Without a slow message (built-in gateways) the copy never changes.
      showCheckoutLoadingOverlay({ title: "Opening secure payment", message: "Continue" });
      vi.advanceTimersByTime(SLOW_REDIRECT_AFTER_MS * 2);
      expect(message?.textContent).toBe("Continue");
    } finally {
      vi.useRealTimers();
    }
  });
});
