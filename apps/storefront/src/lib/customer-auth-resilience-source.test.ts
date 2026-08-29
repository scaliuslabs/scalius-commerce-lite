import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = (() => {
  const packageRelative = process.cwd();
  if (existsSync(join(packageRelative, "src/pages/account.astro")))
    return packageRelative;
  return join(process.cwd(), "apps/storefront");
})();

function readStorefrontSource(pathFromRoot: string): string {
  return readFileSync(join(storefrontRoot, pathFromRoot), "utf8");
}

describe("customer auth resilience source boundaries", () => {
  it("renders a retryable account state when the session read is temporarily unavailable", () => {
    const source = readStorefrontSource("src/pages/account.astro");

    expect(source).toContain('id="accountError"');
    expect(source).toContain('id="accountRetryBtn"');
    expect(source).toContain("if (session.unavailable) {");
    expect(source).toContain('accountError.classList.remove("hidden")');
    expect(source).toContain('unauthState.classList.remove("hidden")');
  });

  it("keeps private order detail failures separate from logged-out state", () => {
    const source = readStorefrontSource("src/pages/account/orders/[id].astro");

    expect(source).toContain("if (session.unavailable) {");
    expect(source).toContain("Account temporarily unavailable");
    expect(source).toContain("if (result.status === 401) {");
    expect(source).toContain("result.unavailable");
    expect(source).toContain('showOnly("error")');
  });

  it("surfaces payment and refund context on account order-list cards", () => {
    const source = readStorefrontSource("src/pages/account.astro");

    expect(source).toContain(
      "function renderOrderPaymentContext(order: CustomerOrder): string",
    );
    expect(source).toContain("Payment needs attention");
    expect(source).toContain("balance due");
    expect(source).toContain("Refund or return update");
    expect(source).toContain(
      "Open the timeline for buyer-safe refund and return details.",
    );
    expect(source).toContain("${renderOrderPaymentContext(order)}");
  });

  it("does not open the auth modal when checkout session verification is temporarily unavailable", () => {
    const source = readStorefrontSource("src/pages/cart.astro");

    expect(source).toContain(
      "const session = await readCustomerSessionForCheckout();",
    );
    expect(source).toContain("if (session.unavailable) {");
    expect(source).toContain("showCheckoutFormError(");
    expect(source).toContain(
      "checkoutCopy.accountUnavailableText,",
    );
    expect(source).not.toMatch(/\b(?:window\.)?alert\s*\(/);
    expect(source).toContain("if (!session.authenticated) {");
    expect(source).toContain(
      'window.dispatchEvent(new CustomEvent("open-auth-modal"));',
    );
  });

  it("keeps storefront customer forms out of native GET query strings", () => {
    const cartSource = readStorefrontSource("src/pages/cart.astro");
    const authModalSource = readStorefrontSource(
      "src/components/AuthModal.tsx",
    );

    expect(cartSource).toMatch(
      /<form\b[^>]*id="discountForm"[^>]*method="post"[^>]*action="\/cart"[^>]*novalidate/s,
    );
    expect(cartSource).toMatch(/<input\b[^>]*id="discountCodeInput"[^>]*>/);
    expect(cartSource).not.toMatch(
      /<input\b[^>]*id="discountCodeInput"[^>]*\bname=/,
    );
    expect(cartSource).toMatch(
      /<form\b[^>]*method="POST"[^>]*action="\/cart"[^>]*id="checkoutForm"[\s\S]*name="formIntent"[\s\S]*value="checkout"/,
    );
    expect(cartSource).toMatch(
      /<form\b[^>]*method="POST"[^>]*action="\/cart"[^>]*id="checkoutForm"[^>]*novalidate/s,
    );
    expect(cartSource).toContain(
      'if (formData.get("formIntent") === "checkout") {',
    );
    expect(authModalSource).not.toMatch(/<form\b/);
    expect(authModalSource).not.toMatch(
      /name="(?:phone|email|otp|code|password|token)"/,
    );
  });

  it("lets explicit empty checkout edits replace older saved buyer details", () => {
    const cartSource = readStorefrontSource("src/pages/cart.astro");

    expect(cartSource).toContain("const values: Record<string, string> = {};");
    expect(cartSource).toContain(
      'else if (input) values[field] = inputValue ?? "";',
    );
    expect(cartSource).toContain(
      'else if (draft && field in draft) values[field] = draft[field] ?? "";',
    );
    expect(cartSource).toContain("persistCheckoutFormDraftNow();");
    expect(cartSource).not.toContain("shippingAddressInput?.reportValidity()");
  });

  it("keeps phone restoration component-owned and preserves explicit buyer clears", () => {
    const cartSource = readStorefrontSource("src/pages/cart.astro");
    const phoneSource = readStorefrontSource("src/components/PhoneField.tsx");

    expect(cartSource).toContain(
      'for (const field of [\n      "customerName",\n      "customerEmail"',
    );
    expect(cartSource).toContain(
      'new CustomEvent("phone-prefill", { detail: draft.customerPhone })',
    );
    expect(phoneSource).toContain(
      'Object.prototype.hasOwnProperty.call(draft, "customerPhone")',
    );
    expect(phoneSource).toContain(
      "? draft.customerPhone\n        : defaultValue;",
    );
    expect(phoneSource).toContain('return result.ok ? result.value : "";');
    expect(cartSource).toContain("let phoneFieldHasBuyerEdit = false;");
    expect(cartSource).toContain("!phoneFieldHasBuyerEdit &&");
    expect(cartSource).toContain(
      '(event.target as HTMLInputElement | null)?.id === "customerPhone-input"',
    );
    expect(cartSource).toContain("phoneFieldHasBuyerEdit = true;");
    expect(cartSource).toContain(
      'document.addEventListener(\n    "astro:before-swap"',
    );
    expect(cartSource).toContain("cartPageAbortController.abort();");
    expect(cartSource).toContain("event.isTrusted &&");
    expect(cartSource).not.toContain(
      "phoneInput.value = phoneValidation.value;",
    );
    expect(phoneSource).toContain("name={name}");
    expect(phoneSource).toContain('type="hidden"');
    expect(phoneSource).toContain("data-e164-value={canonicalValue}");
    expect(phoneSource).toContain(
      "persistCanonicalValue(normalizePhone(nextValue));",
    );
    expect(phoneSource).toContain(
      "syncCheckoutTransferSession({ customerPhone: phone });",
    );
    expect(phoneSource).toContain("if (buyerHasEdited.current) return;");
    expect(cartSource).toContain("input.dataset.e164Value !== undefined");
    expect(cartSource).toContain(
      "checkoutData.customerPhone = phoneValidation.value;",
    );
  });

  it("keeps post-sale payment recovery controls out of native forms", () => {
    const orderSuccessSource = readStorefrontSource(
      "src/pages/order-success.astro",
    );
    const orderSuccessButtonsSource = readStorefrontSource(
      "src/components/OrderSuccessButtons.tsx",
    );
    const accountOrderSource = readStorefrontSource(
      "src/pages/account/orders/[id].astro",
    );

    for (const source of [
      orderSuccessSource,
      orderSuccessButtonsSource,
      accountOrderSource,
    ]) {
      expect(source).not.toMatch(/<form\b/);
      expect(source).not.toMatch(
        /name="(?:phone|email|otp|code|password|token|receiptToken|orderId)"/,
      );
    }
  });

  it("buffers auth modal opens before the interaction-loaded React root mounts", () => {
    const source = readStorefrontSource("src/layouts/Layout.astro");
    const runtimeSource = readStorefrontSource("src/scripts/lazy-global-ui.ts");

    expect(source).toContain(
      'import { installLazyGlobalUi } from "@/scripts/lazy-global-ui";',
    );
    expect(source).not.toContain("<AuthModal client:");
    expect(runtimeSource).toContain(
      "window.__scaliusAuthModalOpenPending = true;",
    );
    expect(runtimeSource).toContain(
      "window.__scaliusAuthModalIntentPending = intent;",
    );
    expect(runtimeSource).toContain("const loadAuth = (");
    expect(runtimeSource).toContain(
      "const resumeAuth = () => void loadAuth(false);",
    );
    expect(runtimeSource).toContain(
      'window.addEventListener("open-auth-modal", (event) => {',
    );
    expect(runtimeSource).toContain("void loadAuth(true, requestedIntent);");
    expect(runtimeSource).toContain(
      'import("@/components/client/mount-auth-modal")',
    );
    expect(runtimeSource).toContain("if (hasCustomerAuthMirrorCookie()) {");
  });

  it("consumes pending auth modal opens after registering the hydrated listener", () => {
    const source = readStorefrontSource("src/components/AuthModal.tsx");

    const listenerIndex = source.indexOf(
      'window.addEventListener("open-auth-modal", handleOpen);',
    );
    const pendingIndex = source.indexOf(
      "if (window.__scaliusAuthModalOpenPending) {",
    );

    expect(source).toContain("delete window.__scaliusAuthModalOpenPending;");
    expect(source).toContain(
      "eventIntent ?? window.__scaliusAuthModalIntentPending",
    );
    expect(source).toContain("delete window.__scaliusAuthModalIntentPending;");
    expect(listenerIndex).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeGreaterThan(listenerIndex);
    expect(source).toContain("handleOpen();");
  });

  it("offers account creation directly from a send-time account-not-found error", () => {
    const source = readStorefrontSource("src/components/AuthModal.tsx");
    const inputStateStart = source.indexOf('{step === "input"');
    const otpStateStart = source.indexOf('{step === "otp"');
    const inputStateSource = source.slice(inputStateStart, otpStateStart);

    expect(inputStateStart).toBeGreaterThanOrEqual(0);
    expect(otpStateStart).toBeGreaterThan(inputStateStart);
    expect(inputStateSource).toContain("setAuthIntent(alternateAuthIntent)");
    expect(inputStateSource).toContain(
      "getCustomerAuthAlternateIntentLabel(alternateAuthIntent)",
    );
  });

  it("keeps global auth hydration free of guest checkout/session network reads", () => {
    const authModalSource = readStorefrontSource(
      "src/components/AuthModal.tsx",
    );
    const cartSource = readStorefrontSource("src/pages/cart.astro");

    expect(authModalSource).not.toContain("fetchInitData");
    expect(authModalSource).toContain("function readInjectedCheckoutConfig()");
    expect(authModalSource).toContain("void ensureAuthSettings();");
    expect(authModalSource).toContain("if (hasCustomerAuthMirrorCookie()) {");
    expect(authModalSource).toContain("scheduleCustomerSessionResume();");
    expect(authModalSource).toContain("window.__CHECKOUT_CONFIG__");
    expect(cartSource).toContain(
      "const serializedCheckoutConfig = serializeJsonForInlineScript(checkoutConfig);",
    );
    expect(cartSource).toContain(
      "window.__CHECKOUT_CONFIG__=${serializedCheckoutConfig};",
    );
  });

  it("resumes incomplete customer profiles instead of silently authenticating them", () => {
    const source = readStorefrontSource("src/components/AuthModal.tsx");

    expect(source).toContain("state.customer.needsProfileCompletion");
    expect(source).toContain("hydrateProfileFields(state.customer)");
    expect(source).toContain('setStep("profile_setup")');
    expect(source).toContain(
      "Save your delivery profile or sign out to continue.",
    );
    expect(source).toContain("detail: customerData");
  });

  it("marks every required profile text field visibly and semantically", () => {
    const source = readStorefrontSource("src/components/AuthModal.tsx");

    expect(source).toContain('htmlFor="profile-name"');
    expect(source).toContain('id="profile-name"');
    expect(source).toContain('autoComplete="name"');
    expect(source).toContain('htmlFor="profile-address"');
    expect(source).toContain('id="profile-address"');
    expect(source).toContain('autoComplete="street-address"');
    expect(
      source.match(/<input\s+[\s\S]*?required[\s\S]*?autoComplete=/g),
    ).toHaveLength(2);
    expect(
      source.match(/aria-hidden="true"[\s\S]*?\(required\)/g),
    ).toHaveLength(2);
    expect(
      source.match(/className="h-11 w-full[\s\S]*?sm:h-10"/g),
    ).toHaveLength(2);
  });
});
