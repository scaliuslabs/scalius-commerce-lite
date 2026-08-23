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
    expect(pageSource).toContain("matchesCheckoutRecoverySession");
    expect(pageSource).toContain("syncCartFromStorage");
    expect(pageSource).toContain("resolveCheckoutReceiptCleanup");
    expect(pageSource).toContain("clearHostedPaymentRecoverySession");
    expect(pageSource).toContain("[data-order-finalize='true'][data-fb-order-details]");
    expect(pageSource).toContain("if (cleanup.clearCart) clearCart();");
    expect(pageSource).toContain("if (cleanup.clearCheckoutSession) clearCheckoutSession();");
    expect(pageSource).toContain("preserveFormDraft: true");
    expect(pageSource).not.toContain("currentCheckoutFinalize || matchingHostedCheckout");
    expect(pageSource).not.toContain("private receipt cookie");
    expect(pageSource).toContain("This receipt can only be opened in the browser used at checkout.");
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
    expect(buttonsSource).toContain("Save this order to your account");
    expect(buttonsSource).toContain("Create an account with the phone saved on this order");
    expect(buttonsSource).toContain("sign in with a matching phone or email");
    expect(buttonsSource).not.toContain("navigator.clipboard");
    expect(buttonsSource).not.toContain("opacity-0");
    expect(buttonsSource).toContain('href="/"');
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

    expect(buttonsSource).toContain("Need help?");
    expect(buttonsSource).toContain("/api/order-support/receipt-request");
    expect(buttonsSource).toContain("setSupportRequests(payload.data.supportRequests");
    expect(buttonsSource).not.toContain("supportRequestIntro: initialSupportRequestIntro =");
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

    expect(pageSource).toContain('initialState !== "payment_pending" && initialState !== "payment_issue"');
    expect(pageSource).toContain('receipt.dataset.paymentMethod !== "stripe"');
    expect(pageSource).toContain('fetch("/api/checkout/stripe-reconcile"');
    expect(pageSource).toContain("/api/order-receipt/status?orderId=");
    expect(pageSource).toContain('credentials: "same-origin"');
    expect(pageSource).toContain('cache: "no-store"');
    expect(pageSource).toContain("state !== initialState");
    expect(pageSource).toContain("updatedAt !== initialUpdatedAt");
    expect(pageSource).toContain('window.addEventListener("pageshow"');
    expect(pageSource).toContain("window.location.reload()");
    expect(pageSource).not.toContain("X-Receipt-Token");
    expect(pageSource).not.toContain("receiptToken=${");
    expect(pageSource.indexOf('fetch("/api/checkout/stripe-reconcile"'))
      .toBeLessThan(pageSource.indexOf("/api/order-receipt/status?orderId="));
  });
});
