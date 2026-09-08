// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";

import { readCheckoutFormDraft, syncCheckoutTransferSession, writeCheckoutFormDraft } from "@/lib/checkout/session-state";
import { findNamedCheckoutControl } from "@/lib/checkout/form-controls";
import { validateStorefrontPhone } from "@/lib/phone-country-policy";
import { getEffectiveCartShippingFee } from "@/store/cart";
import { storefrontSourcePath } from "@/lib/test-source-paths";
import type { AuthState } from "@/lib/api/customer-auth";
import PhoneField from "./PhoneField";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function enterPhone(input: HTMLInputElement, phone: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, phone);
  const event = new Event("input", { bubbles: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  input.dispatchEvent(event);
}

describe("PhoneField", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    sessionStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("keeps the labeled visible control and canonical form value in one controlled state", async () => {
    await act(async () => {
      root.render(
        <form id="checkout-form">
          <PhoneField name="customerPhone" label="Phone number" required />
        </form>,
      );
    });

    const label = host.querySelector("label");
    const visibleInput =
      host.querySelector<HTMLInputElement>(".PhoneInputInput");
    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    );

    expect(label?.htmlFor).toBe("customerPhone-input");
    expect(visibleInput?.id).toBe("customerPhone-input");
    expect(visibleInput?.getAttribute("aria-required")).not.toBe("false");
    expect(visibleInput?.name).toBe("");
    expect(canonicalInput?.type).toBe("hidden");
    expect(canonicalInput?.value).toBe("");
  });

  it("claims the saved checkout phone during its first hydrated render", async () => {
    writeCheckoutFormDraft({ customerPhone: "+8801700000000" });

    await act(async () => {
      root.render(
        <form id="checkout-form">
          <PhoneField name="customerPhone" label="Phone number" required />
        </form>,
      );
    });

    const visibleInput =
      host.querySelector<HTMLInputElement>(".PhoneInputInput");
    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    );

    expect(visibleInput?.value).toContain("17");
    expect(canonicalInput?.value).toBe("+8801700000000");
    expect(canonicalInput?.dataset.e164Value).toBe("+8801700000000");
  });

  it("restores a saved phone after hydrating matching server markup", async () => {
    writeCheckoutFormDraft({ customerPhone: "+8801700000000" });
    const browserSessionStorage = sessionStorage;

    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: undefined,
    });
    const serverMarkup = renderToString(
      <PhoneField name="customerPhone" label="Phone number" required />,
    );
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: browserSessionStorage,
    });

    await act(async () => root.unmount());
    host.innerHTML = serverMarkup;
    const recoverableErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(
        host,
        <PhoneField name="customerPhone" label="Phone number" required />,
        { onRecoverableError: (error) => recoverableErrors.push(error) },
      );
    });

    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    );
    expect(recoverableErrors).toEqual([]);
    expect(canonicalInput?.value).toBe("+8801700000000");
    expect(canonicalInput?.dataset.e164Value).toBe("+8801700000000");
  });

  it("updates the authoritative visible value after an external prefill", async () => {
    await act(async () => {
      root.render(
        <form id="checkout-form">
          <PhoneField name="customerPhone" label="Phone number" required />
        </form>,
      );
    });

    const visibleInput =
      host.querySelector<HTMLInputElement>(".PhoneInputInput");
    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("phone-prefill", { detail: "+8801712345678" }),
      );
    });

    expect(visibleInput?.value).toContain("17");
    expect(canonicalInput?.value).toBe("+8801712345678");
    expect(canonicalInput?.dataset.e164Value).toBe("+8801712345678");
    expect(
      new FormData(host.querySelector<HTMLFormElement>("#checkout-form")!).get(
        "customerPhone",
      ),
    ).toBe("+8801712345678");
  });

  it("lets an explicit empty draft override a signed-in profile default", async () => {
    writeCheckoutFormDraft({ customerPhone: "" });

    await act(async () => {
      root.render(
        <PhoneField
          name="customerPhone"
          defaultValue="+8801712345678"
          label="Phone number"
          required
        />,
      );
    });

    expect(
      host.querySelector<HTMLInputElement>(".PhoneInputInput")?.value,
    ).toBe("+880");
    expect(
      host.querySelector<HTMLInputElement>('input[name="customerPhone"]')
        ?.value,
    ).toBe("");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("phone-prefill", { detail: "+8801812345678" }),
      );
    });

    expect(
      host.querySelector<HTMLInputElement>(".PhoneInputInput")?.value,
    ).toBe("+880");
  });

  it("invalidates old draft and payment-transfer values on clear, then replaces both on re-entry", async () => {
    writeCheckoutFormDraft({
      customerName: "Buyer",
      customerPhone: "+8801712345678",
    });
    sessionStorage.setItem(
      "scalius_checkout_data",
      JSON.stringify({
        customerName: "Buyer",
        customerPhone: "+8801712345678",
      }),
    );

    await act(async () => {
      root.render(
        <PhoneField name="customerPhone" label="Phone number" required />,
      );
    });

    const visibleInput =
      host.querySelector<HTMLInputElement>(".PhoneInputInput")!;
    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    )!;

    await act(async () => enterPhone(visibleInput, ""));

    expect(visibleInput.value).toBe("+880");
    expect(canonicalInput.value).toBe("");
    expect(
      JSON.parse(sessionStorage.getItem("scalius_checkout_data") || "{}"),
    ).toMatchObject({ customerName: "Buyer", customerPhone: "" });
    expect(
      JSON.parse(sessionStorage.getItem("scalius_checkout_form_draft") || "{}"),
    ).toMatchObject({ values: { customerName: "Buyer", customerPhone: "" } });

    await act(async () => enterPhone(visibleInput, "+8801812345678"));

    expect(visibleInput.value).toContain("18");
    expect(canonicalInput.value).toBe("+8801812345678");
    expect(
      JSON.parse(sessionStorage.getItem("scalius_checkout_data") || "{}"),
    ).toMatchObject({ customerName: "Buyer", customerPhone: "+8801812345678" });
    expect(
      JSON.parse(sessionStorage.getItem("scalius_checkout_form_draft") || "{}"),
    ).toMatchObject({
      values: { customerName: "Buyer", customerPhone: "+8801812345678" },
    });
  });
});

describe("cart account prefill across PhoneField hydration", () => {
  // Execute the real cart listeners and draft ownership rules with only its
  // session read deferred; the real phone island receives the prefill.
  const source = readFileSync(storefrontSourcePath("pages", "cart.astro"), "utf8")
    .split("<script>")[1]!.split("// ── Multi-gateway checkout redirect")[0]!;
  const parsed = ts.createSourceFile("cart.ts", source, ts.ScriptTarget.ES2022, true);
  const script = ts.transpileModule(
    parsed.statements.filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => statement.getFullText(parsed)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  const customer = { name: "Test customer", phone: "+8801712345678", email: "customer@example.test", address: "Test delivery address" };
  let root: Root | undefined;
  let host: HTMLDivElement;
  let resolveSession: (state: AuthState) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    sessionStorage.clear();
    document.cookie = "cs_auth=1; path=/";
    document.body.innerHTML = `<div id="checkout-meta" data-guest-checkout-enabled="true"></div>
      <form id="checkoutForm"><input id="customerName" name="customerName" />
        <div id="phone-host"></div><input id="customerEmail" name="customerEmail" />
        <textarea id="shippingAddress" name="shippingAddress"></textarea></form>`;
    host = document.getElementById("phone-host") as HTMLDivElement;
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    window.__scaliusCartPageAbortController?.abort();
    delete window.__scaliusCartPageAbortController;
    document.body.innerHTML = "";
    document.cookie = "cs_auth=; Max-Age=0; path=/";
    sessionStorage.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startCart(countries: string[] = []) {
    const phone = <PhoneField name="customerPhone" label="Phone number" required allowedCountries={countries} />;
    host.innerHTML = renderToString(phone);
    const dependencies = {
      initCartFunctionality: () => Promise.resolve(),
      getCustomerSession: () => new Promise<AuthState>((resolve) => { resolveSession = resolve; }),
      getEffectiveCartShippingFee, readCheckoutFormDraft, syncCheckoutTransferSession,
      writeCheckoutFormDraft, findNamedCheckoutControl, validateStorefrontPhone, ENGLISH_CHECKOUT_LANGUAGE_DATA,
    };
    new Function(...Object.keys(dependencies), script)(...Object.values(dependencies));
    return async () => {
      const recoverableErrors = vi.fn();
      await act(async () => { root = hydrateRoot(host, phone, { onRecoverableError: recoverableErrors }); });
      expect(recoverableErrors).not.toHaveBeenCalled();
    };
  }

  function canonicalInput() {
    return host.querySelector<HTMLInputElement>('input[name="customerPhone"]')!;
  }

  it.each([
    { accountFirst: true, countries: [] }, { accountFirst: false, countries: [] },
    { accountFirst: true, countries: ["BD"] }, { accountFirst: false, countries: ["BD"] },
  ])("restores the phone with accountFirst=$accountFirst and countries=$countries", async ({ accountFirst, countries }) => {
    const hydrate = startCart(countries);
    expect(readCheckoutFormDraft()).toBeNull();
    if (!accountFirst) await hydrate();
    await act(async () => { resolveSession({ authenticated: true, customer }); });
    if (accountFirst) await hydrate();
    expect(canonicalInput().value).toBe(customer.phone);
    expect(canonicalInput().dataset.e164Value).toBe(customer.phone);
    expect(new FormData(document.querySelector<HTMLFormElement>("#checkoutForm")!).get("customerPhone")).toBe(customer.phone);
    expect(validateStorefrontPhone(canonicalInput().value, { countries, mode: "include" }).ok).toBe(true);
    expect(readCheckoutFormDraft()?.customerPhone).toBe(customer.phone);
  });

  it.each(["", "+8801812345678"])("preserves the buyer's %s edit before a late account response", async (phone) => {
    const hydrate = startCart();
    await hydrate();
    const input = host.querySelector<HTMLInputElement>(".PhoneInputInput")!;
    await act(async () => enterPhone(input, "+8801912345678"));
    await act(async () => enterPhone(input, phone));
    await act(async () => { resolveSession({ authenticated: true, customer }); });
    expect(canonicalInput().value).toBe(phone);
    expect(readCheckoutFormDraft()?.customerPhone).toBe(phone);
  });

  it.each(["", "+8801812345678"])("preserves a saved %s phone through account-first hydration", async (phone) => {
    writeCheckoutFormDraft({ customerPhone: phone });
    const hydrate = startCart();
    await act(async () => { resolveSession({ authenticated: true, customer }); });
    await hydrate();
    expect(canonicalInput().value).toBe(phone);
    expect(readCheckoutFormDraft()?.customerPhone).toBe(phone);
  });

  it("keeps a profile phone outside the allowed countries out of canonical form data", async () => {
    const hydrate = startCart(["BD"]);
    const phone = "+12025550123";
    await act(async () => { resolveSession({ authenticated: true, customer: { ...customer, phone } }); });
    expect(readCheckoutFormDraft()?.customerPhone).toBe(phone);
    await hydrate();
    expect(canonicalInput().value).toBe("");
    expect(canonicalInput().dataset.e164Value).toBe("");
    const submittedPhone = new FormData(document.querySelector<HTMLFormElement>("#checkoutForm")!).get("customerPhone");
    expect(submittedPhone).toBe("");
    expect(validateStorefrontPhone(String(submittedPhone), { countries: ["BD"], mode: "include" }).ok).toBe(false);
    const input = host.querySelector<HTMLInputElement>(".PhoneInputInput")!;
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it.each([undefined, null])("does not claim a draft phone when the profile phone is %s", async (phone) => {
    const hydrate = startCart();
    // Null is a defensive runtime boundary beyond the typed optional phone.
    await act(async () => { resolveSession({ authenticated: true, customer: { ...customer, phone } } as AuthState); });
    await hydrate();
    expect(canonicalInput().value).toBe("");
    expect(readCheckoutFormDraft()).toBeNull();
  });

  it("honors a native clear before hydration and before draft debounce", async () => {
    const hydrate = startCart();
    enterPhone(host.querySelector<HTMLInputElement>(".PhoneInputInput")!, "");
    expect(readCheckoutFormDraft()).toBeNull();
    await act(async () => { resolveSession({ authenticated: true, customer }); });
    await hydrate();
    expect(canonicalInput().value).toBe("");
    await vi.advanceTimersByTimeAsync(120);
    expect(readCheckoutFormDraft()?.customerPhone).toBe("");
  });
});
