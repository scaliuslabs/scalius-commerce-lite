// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminPages: vi.fn(),
  postApiV1AdminPages: vi.fn(),
  getApiV1AdminSettingsBusiness: vi.fn(),
}));
const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../media-manager", () => ({ MediaManager: () => null }));
vi.mock("~/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api")>()),
  apiClient: client,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { PoliciesCard } from "./PoliciesCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
let policies = { refund: null as string | null, privacy: null, terms: null, shipping: null, contact: null, revision: 0 };

describe("policies", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    policies = { refund: null, privacy: null, terms: null, shipping: null, contact: null, revision: 0 };
    client.get.mockImplementation(() => envelope(policies));
    client.put.mockImplementation(({ body }: { body: Record<string, unknown> }) => {
      const { expectedRevision, ...patch } = body;
      policies = { ...policies, ...patch, revision: (expectedRevision as number) + 1 };
      return envelope(policies);
    });
    sdk.getApiV1AdminPages.mockImplementation(() => envelope({
      pages: [{ id: "page_privacy", title: "Privacy", slug: "privacy", isPublished: true }],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    }));
    sdk.getApiV1AdminSettingsBusiness.mockImplementation(() => envelope({
      companyName: "Dokan", email: "hello@dokan.com", phone: "01712345678", addressLine1: "House 1", city: "Dhaka",
    }));
    sdk.postApiV1AdminPages.mockImplementation(() => envelope({ id: "page_new", revision: 1 }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  const render = async (permissions: string[]) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider permissions={permissions}><PoliciesCard canEdit /></PermissionProvider>
        </QueryClientProvider>,
      );
    });
  };
  const openRefundPolicy = async () => {
    const row = await vi.waitFor(() => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith("Return and refund policy"));
      expect(button).toBeDefined();
      return button!;
    });
    await act(async () => row.click());
  };

  it("without page access, keeps the link read-only and offers no template", async () => {
    await render(["settings.seo.edit"]);
    await openRefundPolicy();
    await vi.waitFor(() => expect(document.body.textContent).toContain("You need access to pages to change this."));
    expect([...document.querySelectorAll("button")].some((item) => item.textContent === "Create from template")).toBe(false);
    expect(sdk.getApiV1AdminPages).not.toHaveBeenCalled();
  });

  it("creates a draft policy page from the template, links it and opens it", async () => {
    await render(["settings.seo.edit", "pages.view", "pages.create"]);
    const row = await vi.waitFor(() => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith("Return and refund policy"));
      expect(button?.textContent).toContain("Not set");
      return button!;
    });
    await act(async () => row.click());
    const create = await vi.waitFor(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Create from template");
      expect(button).toBeDefined();
      return button!;
    });
    await act(async () => create.click());

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/admin/pages/$pageId/edit", params: { pageId: "page_new" } }));
    const page = sdk.postApiV1AdminPages.mock.calls[0]![0].body;
    expect(page).toMatchObject({ title: "Return and refund policy", slug: "refund-policy", isPublished: false });
    expect(page.content).toContain("Dokan");
    expect(page.content).toContain("01712345678");
    expect(client.put).toHaveBeenCalledWith(expect.objectContaining({ body: { refund: "page_new", expectedRevision: 0 } }));
  });
});
