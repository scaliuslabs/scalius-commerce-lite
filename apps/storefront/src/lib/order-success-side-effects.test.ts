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
    expect(pageSource).toContain("[data-order-finalize='true'][data-fb-order-details]");
    expect(pageSource.indexOf("[data-order-finalize='true'][data-fb-order-details]"))
      .toBeLessThan(pageSource.indexOf("clearCart();"));
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
    expect(buttonsSource).toContain("Keep this browser receipt");
    expect(buttonsSource).toContain("Guest receipts stay available in this browser for a limited time.");
    expect(buttonsSource).toContain("Account history only includes orders placed while signed in.");
    expect(buttonsSource).toContain("navigator.clipboard");
    expect(buttonsSource).toContain("Sign In For Future Orders");
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
