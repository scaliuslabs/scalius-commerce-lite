// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { customerSegmentMessages } from "~/i18n/customer-segments";
import { saveBarMessages } from "~/i18n/save-bar";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsCurrency: vi.fn(),
  postApiV1AdminCustomersSegmentsPreview: vi.fn(),
  postApiV1AdminCustomersSegments: vi.fn(),
  putApiV1AdminCustomersSegmentsBySegmentId: vi.fn(),
  getApiV1AdminCustomersSegmentsBySegmentId: vi.fn(),
  deleteApiV1AdminCustomersSegmentsBySegmentId: vi.fn(),
  getApiV1AdminCustomersTags: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => navigate,
  Link: ({ to, children, search: _search, params: _params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode; search?: unknown; params?: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SegmentEditor } from "./SegmentEditor";
import type { CustomerSegment } from "~/lib/api-query-options/customers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof customerSegmentMessages.en, vars?: Record<string, string | number>) => translate(customerSegmentMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const refused = (status: number, message: string) =>
  Promise.resolve({ error: { success: false, error: { code: "conflict", message } }, response: { status } });

const DEFINITION = {
  version: 1 as const,
  match: "all" as const,
  conditions: [
    { field: "orders_count" as const, min: 2 },
    { field: "marketing_consent" as const, channel: "sms" as const, status: "subscribed" as const },
  ],
};

const SEGMENT: CustomerSegment = {
  id: "seg_vip0001",
  name: "Repeat SMS buyers",
  description: null,
  definition: DEFINITION,
  revision: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  promotionCount: 0,
};

const CUSTOMER = {
  id: "cus_1", name: "Rahim", email: null, phone: "+8801712345678", address: null, city: null, zone: null, area: null,
  cityName: null, zoneName: null, areaName: null, accountClaimedAt: null, kind: "account", latestOrderName: null,
  totalOrders: 3, totalSpent: 4500, lastOrderAt: null, createdAt: "", updatedAt: "",
};

async function typeInto(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const pageSave = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === translate(saveBarMessages, "save"))!;

describe("segment editor", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => ok({ currencyCode: "BDT", currencySymbol: "৳" }));
    sdk.postApiV1AdminCustomersSegmentsPreview.mockImplementation(() => ok({ count: 1234, capped: false, customers: [CUSTOMER] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(segment: CustomerSegment | null) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SegmentEditor segment={segment} />
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
  }

  it("previews who the saved filters match and saves a change at the loaded revision", async () => {
    await render(SEGMENT);
    await vi.waitFor(() => expect(sdk.postApiV1AdminCustomersSegmentsPreview).toHaveBeenCalled(), { timeout: 3000 });
    expect(sdk.postApiV1AdminCustomersSegmentsPreview.mock.calls[0]![0]).toMatchObject({ body: { definition: DEFINITION } });
    await vi.waitFor(() => expect(container.textContent).toContain(t("members", { count: 1234 })));
    expect(container.querySelector('a[href="/admin/customers/cus_1/edit"]')?.textContent).toBe("Rahim");

    await typeInto(document.getElementById("segment-name") as HTMLInputElement, "  VIP   buyers ");
    sdk.putApiV1AdminCustomersSegmentsBySegmentId.mockImplementation(() => ok({ ...SEGMENT, name: "VIP buyers", revision: 4 }));
    await act(async () => pageSave().click());
    expect(sdk.putApiV1AdminCustomersSegmentsBySegmentId).toHaveBeenCalledWith({
      path: { segmentId: "seg_vip0001" },
      body: { expectedRevision: 3, name: "VIP buyers", description: null, definition: DEFINITION },
    });
  });

  it("says a filter is needed instead of saving an empty segment", async () => {
    await render(null);
    expect(container.textContent).toContain(t("noFilters"));
    await typeInto(document.getElementById("segment-name") as HTMLInputElement, "Everyone");
    await act(async () => pageSave().click());
    expect(sdk.postApiV1AdminCustomersSegments).not.toHaveBeenCalled();
    expect(container.textContent).toContain(t("needFilter"));
    expect(sdk.postApiV1AdminCustomersSegmentsPreview).not.toHaveBeenCalled();
  });

  it("offers to reload when someone else saved the segment first", async () => {
    await render(SEGMENT);
    await typeInto(document.getElementById("segment-name") as HTMLInputElement, "VIP buyers");
    sdk.putApiV1AdminCustomersSegmentsBySegmentId.mockImplementation(() => refused(409, "This segment changed since you opened it."));
    sdk.getApiV1AdminCustomersSegmentsBySegmentId.mockImplementation(() => ok({ ...SEGMENT, revision: 5 }));
    await act(async () => pageSave().click());
    await vi.waitFor(() => expect(container.textContent).toContain(t("segmentChanged")));
    expect(container.textContent).toContain(translate(saveBarMessages, "reloadKeepEdits"));
  });

  it("tells a taken name from a stale revision", async () => {
    await render(SEGMENT);
    await typeInto(document.getElementById("segment-name") as HTMLInputElement, "Big spenders");
    sdk.putApiV1AdminCustomersSegmentsBySegmentId.mockImplementation(() => refused(409, "Another segment has this name."));
    sdk.getApiV1AdminCustomersSegmentsBySegmentId.mockImplementation(() => ok(SEGMENT));
    await act(async () => pageSave().click());
    await vi.waitFor(() => expect(container.textContent).toContain(t("nameTaken")));
    expect(container.textContent).not.toContain(translate(saveBarMessages, "reloadKeepEdits"));
  });
});
