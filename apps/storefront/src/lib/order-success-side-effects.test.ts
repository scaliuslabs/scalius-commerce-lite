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

    expect(pageSource).toContain("<OrderSuccessButtons orderId={order.id} client:load />");
    expect(buttonsSource).toContain("Keep this private receipt link");
    expect(buttonsSource).toContain("Guest orders are tracked from this private receipt link.");
    expect(buttonsSource).toContain("Account history only includes orders placed while signed in.");
    expect(buttonsSource).toContain("navigator.clipboard");
    expect(buttonsSource).toContain("Sign In For Future Orders");
    expect(buttonsSource).toContain("open-auth-modal");
    expect(buttonsSource).toContain("/account/orders/${encodeURIComponent(orderId)}");
  });

  it("keeps hosted payment retry outside the finalization side-effect path", () => {
    const pageSource = readFileSync(
      sourcePath("pages", "order-success.astro"),
      "utf8",
    );

    expect(pageSource).toContain("id=\"retryPaymentButton\"");
    expect(pageSource).not.toContain("retryKey");
    const retryScriptIndex = pageSource.indexOf('document.getElementById("retryPaymentButton")');
    expect(retryScriptIndex).toBeGreaterThan(pageSource.indexOf("clearCart();"));
    const retryScript = pageSource.slice(retryScriptIndex);
    expect(retryScript).not.toContain("clearCart");
    expect(retryScript).not.toContain("trackFbPurchase");
    expect(retryScript.indexOf('response.status === 202 || data.status === "processing"'))
      .toBeLessThan(retryScript.indexOf("Payment gateway did not return a redirect URL."));
  });
});
