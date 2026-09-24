// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminPages: vi.fn(),
  postApiV1AdminPages: vi.fn(),
  getApiV1AdminSettingsBusiness: vi.fn(),
  getApiV1AdminSettingsStorefrontUrl: vi.fn(),
  getApiV1AdminSettingsCurrency: vi.fn(),
}));
const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast }));
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
let policies = { refund: null as string | null, privacy: null, terms: null, shipping: null as string | null, contact: null, revision: 0 };
const rate = (patch: Record<string, unknown>) => ({
  id: "sm", kind: "delivery", name: "Standard", fee: 60, freeOver: null, description: null,
  pickupAddress: null, pickupHours: null, isActive: true, ...patch,
});
const shippingZones = {
  zones: [{
    id: "dz_1", name: "Inside Dhaka", revision: 1,
    locations: [{ id: "dhaka", name: "Dhaka", type: "city", parentName: null }],
    rates: [rate({ name: "Inside Dhaka", fee: 70, freeOver: 3000, description: "Delivery in 1–2 days" })],
  }],
  everywhereElse: {
    revision: 1,
    rates: [
      rate({ name: "Outside Dhaka", fee: 120.5, description: "Delivery in 2–3 days" }),
      rate({ name: "Courier express", fee: 200, isActive: false }),
      rate({ kind: "pickup", name: "Shop pickup", fee: 0, pickupAddress: "House 1, Dhanmondi <27>", pickupHours: "10 am – 8 pm" }),
    ],
  },
};

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
    client.get.mockImplementation(({ url }: { url: string }) =>
      url.endsWith("/shipping-methods") ? envelope(shippingZones) : envelope(policies));
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
    sdk.getApiV1AdminSettingsStorefrontUrl.mockImplementation(() => envelope({ storefrontUrl: "https://storefront.scalius.com" }));
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => envelope({ currencyCode: "BDT", currencySymbol: "৳" }));
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
  const openPolicy = async (title: string) => {
    const row = await vi.waitFor(() => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith(title));
      expect(button?.textContent).toContain("Not set");
      return button!;
    });
    await act(async () => row.click());
  };
  const openRefundPolicy = () => openPolicy("Return and refund policy");
  const createFromTemplate = async () => {
    const create = await vi.waitFor(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Create from template");
      expect(button).toBeDefined();
      return button!;
    });
    await act(async () => create.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminPages).toHaveBeenCalled());
    return sdk.postApiV1AdminPages.mock.calls[0]![0].body as { title: string; slug: string; content: string; isPublished: boolean };
  };

  it("without page access, keeps the link read-only and offers no template", async () => {
    await render(["settings.seo.edit"]);
    await openRefundPolicy();
    await vi.waitFor(() => expect(document.body.textContent).toContain("You need access to pages to change this."));
    expect([...document.querySelectorAll("button")].some((item) => item.textContent === "Create from template")).toBe(false);
    expect(sdk.getApiV1AdminPages).not.toHaveBeenCalled();
  });

  it("creates a draft policy page from the template, links it and stays in Settings", async () => {
    await render(["settings.seo.edit", "pages.view", "pages.create"]);
    await openRefundPolicy();
    const page = await createFromTemplate();

    expect(page).toMatchObject({ title: "Return and refund policy", slug: "refund-policy", isPublished: false });
    expect(page.content).toContain("Dokan");
    expect(page.content).toContain("01712345678");
    expect(client.put).toHaveBeenCalledWith(expect.objectContaining({ body: { refund: "page_new", expectedRevision: 0 } }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("A draft page is linked."));
    expect([...document.querySelectorAll("a")].some((link) => link.textContent === "Edit page")).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Page created");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("takes the next free page address when an earlier policy page (even one in trash) holds it", async () => {
    sdk.postApiV1AdminPages
      .mockImplementationOnce(() => Promise.resolve({
        error: { success: false, error: { code: "CONFLICT", message: "A page with this slug already exists, including in trash." } },
        response: { status: 409 },
      }))
      .mockImplementation(() => envelope({ id: "page_new", revision: 1 }));
    await render(["settings.seo.edit", "pages.view", "pages.create"]);
    await openRefundPolicy();
    await createFromTemplate();

    await vi.waitFor(() => expect(sdk.postApiV1AdminPages).toHaveBeenCalledTimes(2));
    expect(sdk.postApiV1AdminPages.mock.calls[1]![0].body.slug).toBe("refund-policy-2");
    await vi.waitFor(() => expect(client.put).toHaveBeenCalledWith(expect.objectContaining({ body: { refund: "page_new", expectedRevision: 0 } })));
  });

  it("writes the shipping policy from the saved zones, and names an unnamed store by its address", async () => {
    sdk.getApiV1AdminSettingsBusiness.mockImplementation(() => envelope({
      companyName: " ", email: "", phone: "", addressLine1: "", city: "",
    }));
    await render(["settings.seo.edit", "pages.view", "pages.create", "settings.shipping_methods.view"]);
    await openPolicy("Shipping policy");
    const { content } = await createFromTemplate();

    expect(content).toContain("Here is where storefront.scalius.com delivers");
    expect(content).not.toMatch(/our store|1 to 2 days/);
    expect(content).toContain("<strong>Inside Dhaka</strong> (Dhaka): ৳70, free on orders of ৳3,000 or more. Delivery in 1–2 days.");
    expect(content).toContain("<strong>Everywhere else</strong>: Outside Dhaka ৳120.50. Delivery in 2–3 days.");
    expect(content).not.toContain("Courier express");
    expect(content).toContain("You can collect your order from House 1, Dhanmondi &lt;27&gt; (10 am – 8 pm). Pickup is free.");
  });

  it("without shipping access, the shipping policy states no charges it can't see", async () => {
    await render(["settings.seo.edit", "pages.view", "pages.create"]);
    await openPolicy("Shipping policy");
    const { content } = await createFromTemplate();

    expect(content).toContain("The charge for your address is shown at checkout");
    expect(content).not.toContain("Inside Dhaka");
    expect(client.get).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("shipping-methods") }));
  });
});
