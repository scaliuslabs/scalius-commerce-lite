import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = existsSync(resolve(process.cwd(), "apps", "storefront", "src"))
  ? resolve(process.cwd(), "apps", "storefront")
  : process.cwd();
const sourcePath = (...segments: string[]) => resolve(storefrontRoot, "src", ...segments);

describe("order success side effects", () => {
  it("gates cart cleanup and purchase tracking behind final payment state", () => {
    const pageSource = readFileSync(
      sourcePath("pages", "order-success.astro"),
      "utf8",
    );

    expect(pageSource).toContain("data-order-finalize");
    expect(pageSource).toContain("data-checkout-cart-finalize");
    expect(pageSource).toContain("data-current-checkout-finalize");
    expect(pageSource).toContain("matchesCheckoutRecoveryCart");
    expect(pageSource).toContain("const shouldFinalizeThisReceipt = currentCheckoutFinalize || matchingHostedCheckout");
    expect(pageSource).toContain("clearHostedPaymentRecoverySession");
    expect(pageSource).toContain("[data-order-finalize='true'][data-fb-order-details]");
    expect(pageSource.indexOf('receiptElement.dataset.checkoutCartFinalize === "true"'))
      .toBeLessThan(pageSource.indexOf("clearCart();"));
    expect(pageSource.indexOf("if (shouldFinalizeThisReceipt) clearCheckoutSession();"))
      .toBeGreaterThan(pageSource.indexOf("const shouldFinalizeThisReceipt"));
  });

  it("keeps hosted redirects from clearing the cart before authoritative receipt finalization", () => {
    const checkoutSource = readFileSync(
      sourcePath("lib", "checkout", "index.ts"),
      "utf8",
    );
    const handlerSources = ["cod.ts", "sslcommerz.ts", "polar.ts", "stripe.ts"]
      .map((file) => readFileSync(sourcePath("lib", "checkout", "handlers", file), "utf8"))
      .join("\n");

    expect(checkoutSource).not.toContain('localStorage.removeItem("cart")');
    expect(checkoutSource).not.toContain("clearCheckoutAndCart");
    expect(handlerSources).not.toContain("clearCartOnRedirect");
  });

  it("keeps navigation buttons free of cart-clearing side effects", () => {
    const buttonsSource = readFileSync(
      sourcePath("components", "OrderSuccessButtons.tsx"),
      "utf8",
    );

    expect(buttonsSource).not.toContain("clearCart");
    expect(buttonsSource).not.toContain("@/store/cart");
  });

  it("guides guest receipts without pretending they are account-owned", () => {
    const pageSource = readFileSync(
      sourcePath("pages", "order-success.astro"),
      "utf8",
    );
    const buttonsSource = readFileSync(
      sourcePath("components", "OrderSuccessButtons.tsx"),
      "utf8",
    );

    expect(pageSource).toContain("<OrderSuccessButtons");
    expect(pageSource).toContain("orderId={order.id}");
    expect(pageSource).toContain("supportRequests={order.supportRequests}");
    expect(pageSource).toContain("supportRequestActions={order.supportRequestActions}");
    expect(pageSource).toContain("supportRequestIntro={order.supportRequestIntro}");
    expect(buttonsSource).toContain("Track this order from any device");
    expect(buttonsSource).toContain("We securely add the order if it is not already saved there.");
    expect(buttonsSource).not.toContain("navigator.clipboard");
    expect(buttonsSource).toContain("/api/order-receipt/claim-account");
    expect(buttonsSource).toContain("Create account");
    expect(buttonsSource).toContain("Sign in");
    expect(buttonsSource).toContain("open-auth-modal");
    expect(buttonsSource).toContain("/account/orders/${encodeURIComponent(orderId)}");
  });

  it("lets guest receipts request support without exposing receipt proof as a component prop", () => {
    const pageSource = readFileSync(
      sourcePath("pages", "order-success.astro"),
      "utf8",
    );
    const buttonsSource = readFileSync(
      sourcePath("components", "OrderSuccessButtons.tsx"),
      "utf8",
    );

    expect(buttonsSource).toContain("Need help with this order?");
    expect(buttonsSource).toContain("/api/order-support/receipt-request");
    expect(buttonsSource).toContain("setSupportRequests(payload.data.supportRequests");
    expect(buttonsSource).toContain("supportRequestIntro: initialSupportRequestIntro =");
    expect(buttonsSource).toContain("useState(initialSupportRequestIntro)");
    expect(buttonsSource).toContain("{supportRequestIntro}");
    expect(buttonsSource).toContain(
      "setSupportRequestIntro(payload.data.supportRequestIntro ?? initialSupportRequestIntro)",
    );
    expect(buttonsSource).not.toContain("getReceiptTokenFromUrl");
    expect(buttonsSource).not.toContain("receiptToken");
    expect(pageSource).not.toContain("receiptToken={");
    expect(pageSource).not.toContain("data-receipt-token");
  });

  it("keeps hosted payment retry outside the finalization side-effect path", () => {
    const pageSource = readFileSync(
      sourcePath("pages", "order-success.astro"),
      "utf8",
    );

    expect(pageSource).toContain("data-payment-retry-button");
    expect(pageSource).not.toContain("retryKey");
    const retryScriptIndex = pageSource.indexOf('querySelectorAll<HTMLButtonElement>("[data-payment-retry-button]")');
    expect(retryScriptIndex).toBeGreaterThan(pageSource.indexOf("clearCart();"));
    const retryScript = pageSource.slice(retryScriptIndex);
    expect(retryScript).toContain("fetchPaymentSessionWithProcessingRetry");
    expect(retryScript).toContain('replaceExistingAttempt: paymentType !== "balance"');
    expect(retryScript).not.toContain("clearCart");
    expect(retryScript).not.toContain("trackFbPurchase");
    expect(retryScript).toContain("Retrying in ${event.retryAfterSeconds}s");
    expect(retryScript.indexOf("fetchPaymentSessionWithProcessingRetry"))
      .toBeLessThan(retryScript.indexOf("Payment gateway did not return a redirect URL."));
  });

  it("reconciles pending Stripe payments before bounded receipt status reads", () => {
    const pageSource = readFileSync(
      sourcePath("pages", "order-success.astro"),
      "utf8",
    );

    expect(pageSource).toContain("data-order-success-state='payment_pending'");
    expect(pageSource).toContain('receipt.dataset.paymentMethod !== "stripe"');
    expect(pageSource).toContain('fetch("/api/checkout/stripe-reconcile"');
    expect(pageSource).toContain("/api/order-receipt/status?orderId=");
    expect(pageSource).toContain('credentials: "same-origin"');
    expect(pageSource).toContain('cache: "no-store"');
    expect(pageSource).toContain('state !== "payment_pending"');
    expect(pageSource).toContain("window.location.reload()");
    expect(pageSource).not.toContain("X-Receipt-Token");
    expect(pageSource).not.toContain("receiptToken=${");
    expect(pageSource.indexOf('fetch("/api/checkout/stripe-reconcile"'))
      .toBeLessThan(pageSource.indexOf("/api/order-receipt/status?orderId="));
  });
});
