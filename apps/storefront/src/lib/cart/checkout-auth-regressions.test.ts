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
});
