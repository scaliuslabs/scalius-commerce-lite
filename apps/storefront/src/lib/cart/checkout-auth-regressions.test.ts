import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

const storefrontRoot = [cwd(), join(cwd(), "apps/storefront")].find((candidate) =>
  existsSync(join(candidate, "src/pages/cart.astro")),
);

if (!storefrontRoot) {
  throw new Error("Unable to locate storefront package root for cart auth tests");
}

describe("cart checkout auth regressions", () => {
  it("forwards the HttpOnly customer session into COD-only order creation", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/cart.astro"), "utf8");

    expect(source).toContain("getCustomerSessionTokenFromCookie");
    expect(source).toContain("processOrder(formData, {");
    expect(source).toContain("customerSessionToken:");
    expect(source).toContain("waitUntil:");
    expect(source).toContain("Astro.locals.cfContext.waitUntil");
  });

  it("expires a stale COD checkout session before offering a guest retry", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/cart.astro"), "utf8");

    expect(source).toContain('result.errorCode === "CUSTOMER_SESSION_STALE"');
    expect(source).toContain('Astro.cookies.delete("cs_tok"');
    expect(source).toContain('Astro.cookies.delete("cs_auth"');
    expect(source).toContain("staleCustomerSession && checkoutConfig.guestCheckoutEnabled !== false");
    expect(source).toContain("copy.continueAsGuestText");
  });

  it("sets a receipt cookie before COD-only success redirects", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/cart.astro"), "utf8");

    expect(source).toContain("createOrderReceiptCookieHeader");
    expect(source).toContain('response.headers.append("Set-Cookie", receiptCookie)');
    expect(source).toContain("`/order-success?orderId=${encodeURIComponent(result.orderId)}`");
    expect(source).not.toContain(
      "`/order-success?orderId=${encodeURIComponent(result.orderId)}&" + ["to", "ken"].join("") + "=",
    );
  });

  it("does not rely on the readable auth mirror cookie for guest-disabled submits", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/cart.astro"), "utf8");

    expect(source).toContain("const readCustomerSessionForCheckout = async () => getCustomerSession();");
    expect(source).toContain("const session = await readCustomerSessionForCheckout();");
    expect(source).toContain("if (session.unavailable) {");
    expect(source).toContain("window.dispatchEvent(new CustomEvent(\"open-auth-modal\"));");
    expect(source).not.toContain("const hasAuthenticatedCustomerSession = async () => {");
    expect(source).not.toContain("!guestCheckoutEnabled && !isUserLoggedIn()");
  });

  it("keeps account-required checkout fields behind the verified customer gate", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/cart.astro"), "utf8");

    expect(source).toContain('id="checkoutFormCard"');
    expect(source).toContain("{ hidden: checkoutConfig.guestCheckoutEnabled === false }");
    expect(source).toContain("<PhoneField\n                  client:load");
    expect(source).toContain("const revealCheckoutFormForCustomer = () => {");
    expect(source).toContain(
      'document.getElementById("checkoutFormCard")?.classList.remove("hidden")',
    );
    expect(source.match(/revealCheckoutFormForCustomer\(\);/g)).toHaveLength(2);
  });
});
