// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsCheckoutLanguages: vi.fn(),
  putApiV1AdminSettingsCheckoutLanguagesById: vi.fn(),
  postApiV1AdminSettingsCheckoutLanguages: vi.fn(),
  deleteApiV1AdminSettingsCheckoutLanguagesById: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { CheckoutTextCard, termsTextKeepsLinks } from "./CheckoutSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const english = {
  id: "cl_en", name: "English", code: "en", isActive: true, isDefault: true,
  languageData: {}, fieldVisibility: {}, revision: 2,
};

function typeInto(field: HTMLTextAreaElement, value: string) {
  act(() => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label)!;
const note = () => document.getElementById("language-terms-note")?.textContent;

describe("checkout agreement text", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsCheckoutLanguages.mockImplementation(() => ok({ languages: [english] }));
    sdk.putApiV1AdminSettingsCheckoutLanguagesById.mockImplementation(() => ok({ ...english, revision: 3 }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  it("keeps both policy links: explains the tokens, warns when one is removed, and won't save without them", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin><CheckoutTextCard /></PermissionProvider>
        </QueryClientProvider>,
      );
    });
    const row = await vi.waitFor(() => {
      const found = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("English"));
      expect(found).toBeDefined();
      return found!;
    });
    await act(async () => row.click());
    const terms = await vi.waitFor(() => document.querySelector<HTMLTextAreaElement>("#language-terms")!);

    expect(terms.value).toBe("By placing this order, you agree to our {terms} and {privacy}.");
    expect(note()).toBe("{terms} and {privacy} become links to your Terms and Privacy pages (Settings → Policies).");

    typeInto(terms, "By placing this order, you agree to our terms.");
    expect(note()).toBe("The Terms and Privacy links will be missing. Keep {terms} and {privacy} in the text.");
    expect(terms.getAttribute("aria-invalid")).toBe("true");
    await act(async () => button("Save").click());
    expect(sdk.putApiV1AdminSettingsCheckoutLanguagesById).not.toHaveBeenCalled();

    typeInto(terms, "Ordering means you accept our {terms} and {privacy}.");
    await act(async () => button("Save").click());
    await vi.waitFor(() => expect(sdk.putApiV1AdminSettingsCheckoutLanguagesById).toHaveBeenCalledTimes(1));
    const body = sdk.putApiV1AdminSettingsCheckoutLanguagesById.mock.calls[0]![0].body;
    expect(body.languageData.termsText).toBe("Ordering means you accept our {terms} and {privacy}.");
    expect(body.expectedRevision).toBe(2);
  });

  it("keeps links the way the storefront makes them: both tokens, or both link names in older copy", () => {
    const names = { termsLinkText: "Terms of Service", privacyLinkText: "Privacy Policy" };
    expect(termsTextKeepsLinks({ ...names, termsText: "Agree to {terms} and {privacy}." })).toBe(true);
    expect(termsTextKeepsLinks({ ...names, termsText: "Agree to {terms}." })).toBe(false);
    expect(termsTextKeepsLinks({ ...names, termsText: "Agree to our Terms of Service and Privacy Policy." })).toBe(true);
    expect(termsTextKeepsLinks({ ...names, termsText: "Agree to our Terms of Service." })).toBe(false);
    expect(termsTextKeepsLinks({ ...names, termsText: "" })).toBe(false);
  });
});
