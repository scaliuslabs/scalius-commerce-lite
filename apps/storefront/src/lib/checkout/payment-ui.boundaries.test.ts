import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "../test-source-paths";

const cartSource = readFileSync(storefrontSourcePath("pages/cart.astro"), "utf8");
const checkoutSource = readFileSync(
  storefrontSourcePath("pages/checkout.astro"),
  "utf8",
);
const overlaySource = readFileSync(
  storefrontSourcePath("components/CheckoutLoadingOverlay.astro"),
  "utf8",
);

describe("storefront payment transition UI", () => {
  it("shares one accessible, theme-aware loading surface", () => {
    expect(cartSource).toContain("<CheckoutLoadingOverlay");
    expect(checkoutSource).toContain("<CheckoutLoadingOverlay");
    expect(overlaySource).toContain('role="status"');
    expect(overlaySource).toContain('aria-live="polite"');
    expect(overlaySource).toContain("bg-background");
    expect(overlaySource).toContain("motion-safe:animate-spin");
    expect(overlaySource).toContain("focus:outline-none");
    expect(overlaySource).not.toContain("style=");
  });

  it("does not delay navigation or simulate payment progress", () => {
    expect(cartSource).toContain('window.location.href = "/checkout"');
    expect(cartSource).not.toContain("loadingProgressBar");
    expect(checkoutSource).not.toContain("loadingProgressBar");
    expect(checkoutSource).not.toContain("SSL Encrypted");
  });
});
