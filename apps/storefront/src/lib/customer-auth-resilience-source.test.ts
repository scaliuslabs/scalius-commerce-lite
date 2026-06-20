import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = (() => {
  const packageRelative = process.cwd();
  if (existsSync(join(packageRelative, "src/pages/account.astro"))) return packageRelative;
  return join(process.cwd(), "apps/storefront");
})();

function readStorefrontSource(pathFromRoot: string): string {
  return readFileSync(join(storefrontRoot, pathFromRoot), "utf8");
}

describe("customer auth resilience source boundaries", () => {
  it("renders a retryable account state when the session read is temporarily unavailable", () => {
    const source = readStorefrontSource("src/pages/account.astro");

    expect(source).toContain("id=\"accountError\"");
    expect(source).toContain("id=\"accountRetryBtn\"");
    expect(source).toContain("if (session.unavailable) {");
    expect(source).toContain("accountError.classList.remove(\"hidden\")");
    expect(source).toContain("unauthState.classList.remove(\"hidden\")");
  });

  it("keeps private order detail failures separate from logged-out state", () => {
    const source = readStorefrontSource("src/pages/account/orders/[id].astro");

    expect(source).toContain("if (session.unavailable) {");
    expect(source).toContain("Account temporarily unavailable");
    expect(source).toContain("if (result.status === 401) {");
    expect(source).toContain("result.unavailable");
    expect(source).toContain("showOnly(\"error\")");
  });

  it("does not open the auth modal when checkout session verification is temporarily unavailable", () => {
    const source = readStorefrontSource("src/pages/cart.astro");

    expect(source).toContain("const session = await readCustomerSessionForCheckout();");
    expect(source).toContain("if (session.unavailable) {");
    expect(source).toContain("alert(session.error || \"We could not verify your account right now. Please try again.\")");
    expect(source).toContain("if (!session.authenticated) {");
    expect(source).toContain("window.dispatchEvent(new CustomEvent(\"open-auth-modal\"));");
  });

  it("buffers auth modal opens before the idle React island hydrates", () => {
    const source = readStorefrontSource("src/layouts/Layout.astro");

    const bufferIndex = source.indexOf("window.__scaliusAuthModalOpenPending = true;");
    const modalIndex = source.indexOf("<AuthModal client:idle />");

    expect(bufferIndex).toBeGreaterThanOrEqual(0);
    expect(modalIndex).toBeGreaterThan(bufferIndex);
  });

  it("consumes pending auth modal opens after registering the hydrated listener", () => {
    const source = readStorefrontSource("src/components/AuthModal.tsx");

    const listenerIndex = source.indexOf("window.addEventListener(\"open-auth-modal\", handleOpen);");
    const pendingIndex = source.indexOf("if (window.__scaliusAuthModalOpenPending) {");

    expect(source).toContain("delete window.__scaliusAuthModalOpenPending;");
    expect(listenerIndex).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeGreaterThan(listenerIndex);
    expect(source).toContain("handleOpen();");
  });
});
