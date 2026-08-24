import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "../test-source-paths";

const cartSource = readFileSync(storefrontSourcePath("pages/cart.astro"), "utf8");
const checkoutSource = readFileSync(
  storefrontSourcePath("pages/checkout.astro"),
  "utf8",
);
const orderSuccessSource = readFileSync(
  storefrontSourcePath("pages/order-success.astro"),
  "utf8",
);
const overlaySource = readFileSync(
  storefrontSourcePath("components/CheckoutLoadingOverlay.astro"),
  "utf8",
);
const productControllerSource = readFileSync(
  storefrontSourcePath("components/product/scripts/product-controller.ts"),
  "utf8",
);
const checkoutControllerSource = readFileSync(
  storefrontSourcePath("lib/checkout/index.ts"),
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

  it("uses inline checkout errors and a clear secondary shopping action", () => {
    expect(cartSource).not.toContain("alert(");
    expect(productControllerSource).not.toContain("alert(");
    expect(cartSource).toContain('id="checkoutFormMessage"');
    expect(cartSource).toContain('role="alert"');
    expect(cartSource).toContain('<span aria-hidden="true">←</span>');
    expect(cartSource).toContain("border border-border bg-background");
  });

  it("finalizes COD-only carts against the exact submitted cart snapshot", () => {
    expect(cartSource).toContain(
      "cartFingerprintHash: await hashCheckoutCartFingerprint(cartItems)",
    );
    expect(orderSuccessSource).toContain("data-checkout-finalize-cart-hash");
    expect(orderSuccessSource).toContain("directCheckoutMatches");
  });

  it("does not abandon an in-flight order creation behind a UI watchdog", () => {
    expect(checkoutControllerSource).toContain(
      "await handler.processPayment(ctx)",
    );
    expect(checkoutControllerSource).not.toContain("Promise.race");
    expect(checkoutControllerSource).not.toContain("PAYMENT_PROCESS_TIMEOUT_MS");
  });
});
