// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsCheckoutFlow: vi.fn(),
  putApiV1AdminSettingsCheckoutFlow: vi.fn(),
  getApiV1AdminSettingsCheckoutReadiness: vi.fn(),
  getApiV1AdminSettingsCheckoutLanguages: vi.fn(),
  putApiV1AdminSettingsCheckoutLanguagesById: vi.fn(),
  postApiV1AdminSettingsCheckoutLanguages: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveErrorBanner, SaveScope, type SaveScopeState } from "../shared/SaveBar";
import { CustomerContactCard } from "./CheckoutSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const language = (revision: number, fieldVisibility: Record<string, boolean>) => ({
  id: "cl_en",
  name: "English",
  code: "en",
  isActive: true,
  isDefault: true,
  languageData: {},
  fieldVisibility,
  revision,
});
const ALL_ON = { showOrderNotesField: true, showAreaField: true };

function checkbox(label: string): HTMLButtonElement {
  const row = [...document.querySelectorAll("label")].find((element) => element.textContent === label)!;
  return row.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
}

describe("checkout form fields (the two-tab repro)", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsCheckoutFlow.mockImplementation(() => ok({
      guestCheckoutEnabled: true, checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0, revision: 1,
    }));
    sdk.getApiV1AdminSettingsCheckoutReadiness.mockImplementation(() => ok({ hasUsableCustomerSignIn: true }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  it("refuses the stale save, reloads under the edit, and saves both tabs' changes", async () => {
    sdk.getApiV1AdminSettingsCheckoutLanguages
      .mockImplementationOnce(() => ok({ languages: [language(0, ALL_ON)] }))
      // Tab A unticked "Order notes" in the meantime.
      .mockImplementation(() => ok({ languages: [language(1, { ...ALL_ON, showOrderNotesField: false })] }));
    sdk.putApiV1AdminSettingsCheckoutLanguagesById
      .mockImplementationOnce(() => Promise.resolve({
        error: {
          error: {
            code: "SETTINGS_REVISION_CONFLICT",
            message: "These settings changed in another session.",
            details: { document: "checkout_language", expectedRevision: 0, currentRevision: 1 },
          },
        },
        response: { status: 409 },
      }))
      .mockImplementation(() => ok({ language: language(2, {}) }));

    let scope: SaveScopeState | null = null;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={(next) => { scope = next; return null; }}>
              <SaveErrorBanner />
              <CustomerContactCard />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(checkbox("Area (optional)")).toBeTruthy());

    // Tab B unticks "Area" and saves on the revision it loaded.
    await act(async () => { checkbox("Area (optional)").click(); });
    let saved = true;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(false);
    expect(sdk.putApiV1AdminSettingsCheckoutLanguagesById.mock.calls[0]![0].body).toEqual({
      fieldVisibility: { ...ALL_ON, showAreaField: false },
      expectedRevision: 0,
    });
    expect(container.textContent).toContain("Someone else changed these settings since you opened them.");
    // Nothing silently reloaded: the merchant's view is untouched until they choose.
    expect(checkbox("Order notes").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Area (optional)").getAttribute("aria-checked")).toBe("false");

    const reload = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reload and keep my edits")!;
    await act(async () => { reload.click(); });
    await vi.waitFor(() => expect(checkbox("Order notes").getAttribute("aria-checked")).toBe("false"));
    expect(checkbox("Area (optional)").getAttribute("aria-checked")).toBe("false");
    expect(scope!.dirty).toBe(true);

    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    expect(sdk.putApiV1AdminSettingsCheckoutLanguagesById.mock.calls[1]![0].body).toEqual({
      fieldVisibility: { showOrderNotesField: false, showAreaField: false },
      expectedRevision: 1,
    });
  });
});
