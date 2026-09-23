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

describe("checkout flow revision safety", () => {
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
    notifyManager.setNotifyFunction((callback) => callback());
  });

  it("refuses a stale save, keeps the merchant's edit, then saves it on the newer revision", async () => {
    sdk.getApiV1AdminSettingsCheckoutFlow
      .mockImplementationOnce(() => envelope(flow(1)))
      // Another tab saved a different field in the meantime.
      .mockImplementation(() => envelope(flow(2, { partialPaymentAmount: 500 })));
    sdk.putApiV1AdminSettingsCheckoutFlow
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("conflict"), {
          status: 409,
          code: "CHECKOUT_FLOW_REVISION_CONFLICT",
          details: { expectedRevision: 1, currentRevision: 2 },
        })))
      .mockImplementation(({ body }: { body: Record<string, unknown> }) =>
        envelope({ ...body, revision: 3 }));

    const hook: { current: ReturnType<typeof useCheckoutFlowForm> | null } = { current: null };
    function Harness() {
      hook.current = useCheckoutFlowForm(() => true);
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <Harness />
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(hook.current?.values.revision).toBe(1));

    act(() => hook.current!.setValue("guestCheckoutEnabled", false));
    await act(async () => {
      await expect(hook.current!.handleSubmit()).rejects.toThrow();
    });
    expect(sdk.putApiV1AdminSettingsCheckoutFlow.mock.calls[0]![0].body).toMatchObject({ expectedRevision: 1, guestCheckoutEnabled: false });

    // The newer version loads underneath the edit: nothing is overwritten.
    await vi.waitFor(() => expect(hook.current?.values.revision).toBe(2));
    expect(hook.current!.values.guestCheckoutEnabled).toBe(false);
    expect(hook.current!.values.partialPaymentAmount).toBe(500);
    expect(hook.current!.isDirty).toBe(true);

    await act(async () => {
      await hook.current!.handleSubmit();
    });
    expect(sdk.putApiV1AdminSettingsCheckoutFlow.mock.calls[1]![0].body).toMatchObject({
      expectedRevision: 2,
      guestCheckoutEnabled: false,
      partialPaymentAmount: 500,
    });
    await vi.waitFor(() => expect(hook.current?.isDirty).toBe(false));
  });
});
