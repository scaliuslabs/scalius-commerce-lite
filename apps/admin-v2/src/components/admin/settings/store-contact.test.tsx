// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsBusiness: vi.fn(),
  getApiV1AdminSettingsAllowedCountries: vi.fn(),
  postApiV1AdminSettingsBusiness: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../media-manager", () => ({ MediaManager: () => null }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { BusinessCard } from "./StoreSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const business = {
  companyName: "Dokan",
  legalName: "",
  taxId: "",
  phone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateRegion: "",
  postalCode: "",
  country: "Bangladesh",
  invoicePrefix: "INV",
  invoiceLogoUrl: "",
  invoiceFooterText: "",
};

function type(input: HTMLInputElement, value: string) {
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function leave(input: HTMLInputElement) {
  act(() => input.blur());
}

const field = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const note = (id: string) => document.querySelector(`#${id}-note`)?.textContent;

describe("store name and contact", () => {
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

  async function openContactDialog(allowedCountries: string[] = []) {
    sdk.getApiV1AdminSettingsBusiness.mockImplementation(() => envelope(business));
    sdk.getApiV1AdminSettingsAllowedCountries.mockImplementation(() =>
      envelope({ allowedCountries, allowedCountriesMode: "include" }));
    sdk.postApiV1AdminSettingsBusiness.mockImplementation(() => envelope({ message: "ok" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <BusinessCard />
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    const row = await vi.waitFor(() => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Store name and contact"));
      expect(button).toBeDefined();
      return button!;
    });
    act(() => row.click());
    await vi.waitFor(() => expect(field("business-phone")).not.toBeNull());
    await vi.waitFor(() => expect(sdk.getApiV1AdminSettingsAllowedCountries).toHaveBeenCalled());
  }

  it("reads any typing of a Bangladesh mobile, Bangla digits included, as 01XXXXXXXXX", async () => {
    await openContactDialog();
    const phone = field("business-phone");

    type(phone, "০১৭১২-৩৪৫৬৭৮");
    leave(phone);
    expect(phone.value).toBe("01712345678");
    expect(note("business-phone")).not.toContain("Enter");

    type(phone, "+880 1812 345 678");
    leave(phone);
    expect(phone.value).toBe("01812345678");
  });

  it("shows each problem next to its field when it's left, and Save shows them all without saving", async () => {
    await openContactDialog();
    const phone = field("business-phone");
    const email = field("business-email");

    type(phone, "123");
    // Quiet while typing.
    expect(phone.getAttribute("aria-invalid")).not.toBe("true");
    leave(phone);
    expect(note("business-phone")).toBe("Enter a mobile number like 01712-345678, or a full number starting with +.");
    expect(phone.getAttribute("aria-invalid")).toBe("true");

    type(email, "abc");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    await act(async () => { save.click(); });
    expect(note("business-email")).toBe("Enter an email like hello@yourshop.com.");
    expect(note("business-phone")).toContain("01712-345678");
    expect(sdk.postApiV1AdminSettingsBusiness).not.toHaveBeenCalled();

    type(email, "hello@dokan.com");
    type(phone, "+880 1712-345678");
    leave(phone);
    await act(async () => { save.click(); });
    await vi.waitFor(() => expect(sdk.postApiV1AdminSettingsBusiness).toHaveBeenCalledOnce());
    expect(sdk.postApiV1AdminSettingsBusiness.mock.calls[0]![0].body).toMatchObject({
      phone: "01712345678",
      email: "hello@dokan.com",
    });
  });

  it("keeps a full international number when every country is accepted", async () => {
    await openContactDialog();
    const phone = field("business-phone");

    type(phone, "+44 20 7946 0958");
    leave(phone);
    expect(phone.value).toBe("+44 20 7946 0958");
    expect(note("business-phone")).toBe("Shown on invoices. Customers and couriers call this number.");
  });

  it("refuses a number from a country the store doesn't accept", async () => {
    await openContactDialog(["BD"]);
    const phone = field("business-phone");

    type(phone, "+44 20 7946 0958");
    leave(phone);
    expect(phone.value).toBe("+44 20 7946 0958");
    await vi.waitFor(() =>
      expect(note("business-phone")).toBe("Numbers from this country aren't accepted. Change it in Customer countries."));
  });
});
