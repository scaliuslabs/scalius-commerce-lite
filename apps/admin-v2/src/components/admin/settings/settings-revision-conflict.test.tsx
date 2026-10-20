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
    code: "settings_revision_conflict",
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

  async function mount() {
    const hook: { current: ReturnType<typeof useCheckoutFlowForm> | null } = { current: null };
    const scope: { current: SaveScopeState | null } = { current: null };
    function Card() {
      hook.current = useCheckoutFlowForm(() => true, "Checkout");
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={(next) => { scope.current = next; return null; }}>
              <SaveErrorBanner />
              <Card />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(hook.current?.isLoaded).toBe(true));
    return { hook, scope, queryClient };
  }

  it("merges a stale save with the other save when they changed different fields, then saves once more", async () => {
    sdk.getApiV1AdminSettingsCheckoutFlow
      .mockImplementationOnce(() => envelope(flow(1)))
      // Another tab saved a different field in the meantime.
      .mockImplementation(() => envelope(flow(2, { partialPaymentAmount: 500 })));
    sdk.putApiV1AdminSettingsCheckoutFlow
      .mockImplementationOnce(staleRevision)
      .mockImplementation(({ body: { expectedRevision: _loaded, ...saved } }: { body: Record<string, unknown> }) =>
        envelope({ ...saved, revision: 3 }));
    const { hook, scope, queryClient } = await mount();
    // The revision travels beside the values, never inside them.
    expect(hook.current!.values).not.toHaveProperty("revision");

    act(() => hook.current!.setValue("guestCheckoutEnabled", false));
    let saved = false;
    await act(async () => { saved = await scope.current!.saveAll(); });
    expect(saved).toBe(true);
    expect(sdk.putApiV1AdminSettingsCheckoutFlow.mock.calls[0]![0].body).toMatchObject({ expectedRevision: 1, guestCheckoutEnabled: false });
    // Base = what was loaded, theirs = revision 2, mine = the draft: both changes survive.
    expect(sdk.putApiV1AdminSettingsCheckoutFlow.mock.calls[1]![0].body).toMatchObject({
      expectedRevision: 2,
      guestCheckoutEnabled: false,
      partialPaymentAmount: 500,
    });
    await vi.waitFor(() => expect(hook.current?.isDirty).toBe(false));
    expect(hook.current!.values).toMatchObject({ guestCheckoutEnabled: false, partialPaymentAmount: 500 });
    // The next save goes out at the revision this one produced.
    expect(queryClient.getQueryData(["settings", "checkout-flow"])).toMatchObject({ revision: 3 });
  });

  it("never overwrites a field both changed: without a choice it refuses and offers to reload keeping the edit", async () => {
    sdk.getApiV1AdminSettingsCheckoutFlow
      .mockImplementationOnce(() => envelope(flow(1)))
      // Another tab changed the same field to something else.
      .mockImplementation(() => envelope(flow(2, { partialPaymentAmount: 500 })));
    sdk.putApiV1AdminSettingsCheckoutFlow
      .mockImplementationOnce(staleRevision)
      .mockImplementation(({ body: { expectedRevision: _loaded, ...saved } }: { body: Record<string, unknown> }) =>
        envelope({ ...saved, revision: 3 }));
    const { hook, scope } = await mount();

    act(() => hook.current!.setValue("partialPaymentAmount", 300));
    let saved = true;
    await act(async () => { saved = await scope.current!.saveAll(); });
    expect(saved).toBe(false);
    expect(sdk.putApiV1AdminSettingsCheckoutFlow).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Someone else changed these settings since you opened them.");
    expect(hook.current!.values.partialPaymentAmount).toBe(300);
    expect(hook.current!.isDirty).toBe(true);
  });
});
