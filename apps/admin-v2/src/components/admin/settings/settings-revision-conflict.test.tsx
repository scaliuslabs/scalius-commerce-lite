// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsCheckoutFlow: vi.fn(),
  putApiV1AdminSettingsCheckoutFlow: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveErrorBanner, SaveScope, type SaveScopeState } from "../shared/SaveBar";
import { useCheckoutFlowForm } from "./PaymentsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const flow = (revision: number, overrides: Record<string, unknown> = {}) => ({
  guestCheckoutEnabled: true,
  checkoutMode: "all",
  partialPaymentEnabled: false,
  partialPaymentAmount: 100,
  revision,
  ...overrides,
});
/** What the API answers when another session saved the document first. */
const staleRevision = () =>
  Promise.reject(Object.assign(new Error("These settings changed in another session."), {
    status: 409,
    code: "SETTINGS_REVISION_CONFLICT",
    details: { document: "checkout", expectedRevision: 1, currentRevision: 2 },
  }));

describe("settings revision conflict", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  it("refuses a stale save, offers to reload keeping the edit, then saves it on the newer revision", async () => {
    sdk.getApiV1AdminSettingsCheckoutFlow
      .mockImplementationOnce(() => envelope(flow(1)))
      // Another tab saved a different field in the meantime.
      .mockImplementation(() => envelope(flow(2, { partialPaymentAmount: 500 })));
    sdk.putApiV1AdminSettingsCheckoutFlow
      .mockImplementationOnce(staleRevision)
      .mockImplementation(({ body: { expectedRevision: _loaded, ...saved } }: { body: Record<string, unknown> }) =>
        envelope({ ...saved, revision: 3 }));

    const hook: { current: ReturnType<typeof useCheckoutFlowForm> | null } = { current: null };
    let scope: SaveScopeState | null = null;
    function Card() {
      hook.current = useCheckoutFlowForm(() => true, "Checkout");
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={(next) => { scope = next; return null; }}>
              <SaveErrorBanner />
              <Card />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(hook.current?.isLoaded).toBe(true));
    // The revision travels beside the values, never inside them.
    expect(hook.current!.values).not.toHaveProperty("revision");

    act(() => hook.current!.setValue("guestCheckoutEnabled", false));
    let saved = true;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(false);
    expect(sdk.putApiV1AdminSettingsCheckoutFlow.mock.calls[0]![0].body).toMatchObject({
      expectedRevision: 1,
      guestCheckoutEnabled: false,
    });

    // Nothing is overwritten and nothing is reloaded behind the merchant's back.
    expect(container.textContent).toContain("Someone else changed these settings since you opened them.");
    expect(sdk.getApiV1AdminSettingsCheckoutFlow).toHaveBeenCalledOnce();
    expect(hook.current!.values.guestCheckoutEnabled).toBe(false);
    expect(hook.current!.isDirty).toBe(true);

    const reload = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reload and keep my edits")!;
    await act(async () => { reload.click(); });
    await vi.waitFor(() => expect(hook.current!.values.partialPaymentAmount).toBe(500));
    // The merchant's edit sits on top of the latest version; the banner is gone.
    expect(hook.current!.values.guestCheckoutEnabled).toBe(false);
    expect(hook.current!.isDirty).toBe(true);
    expect(container.textContent).not.toContain("Someone else changed");

    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    expect(sdk.putApiV1AdminSettingsCheckoutFlow.mock.calls[1]![0].body).toMatchObject({
      expectedRevision: 2,
      guestCheckoutEnabled: false,
      partialPaymentAmount: 500,
    });
    await vi.waitFor(() => expect(hook.current?.isDirty).toBe(false));
    // The next save goes out at the revision this one produced.
    expect(queryClient.getQueryData(["settings", "checkout-flow"])).toMatchObject({ revision: 3 });
  });
});
