// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsBusiness: vi.fn(),
  getApiV1AdminSettingsAllowedCountries: vi.fn(),
  postApiV1AdminSettingsBusiness: vi.fn(),
  getApiV1AdminSettingsCurrency: vi.fn(),
  getApiV1AdminSettingsStoreDefaults: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../media-manager", () => ({ MediaManager: () => null }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { BusinessCard, StoreDefaultsCard } from "./StoreSettings";

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

  async function openContactDialog(allowedCountries: string[] = [], storedPhone = "") {
    sdk.getApiV1AdminSettingsBusiness.mockImplementation(() => envelope({ ...business, phone: storedPhone }));
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

  it.each([
    ["+880 1712-345678", "01712345678"],
    ["+88029876543", "02-9876543"],
    ["+44 20 7946 0958", "+44 20 7946 0958"],
  ])("keeps a saved phone clean after blur and edit/revert: %s", async (stored, displayed) => {
    await openContactDialog([], stored);
    const phone = field("business-phone");
    await vi.waitFor(() => expect(phone.value).toBe(displayed));
    const save = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!;
    act(() => phone.focus());
    leave(phone);
    expect(save().disabled).toBe(true);
    type(phone, "01912345678");
    leave(phone);
    expect(save().disabled).toBe(false);
    type(phone, displayed);
    leave(phone);
    expect(save().disabled).toBe(true);
    expect(sdk.postApiV1AdminSettingsBusiness).not.toHaveBeenCalled();
  });

  it("treats remove/re-add countries as a set without changing its include/exclude policy", async () => {
    sdk.getApiV1AdminSettingsAllowedCountries.mockImplementation(() =>
      envelope({ allowedCountries: ["US", "BD", "BD"], allowedCountriesMode: "include" }));
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => envelope({ currencyCode: "BDT", currencySymbol: "৳", decimalPlaces: 2 }));
    sdk.getApiV1AdminSettingsStoreDefaults.mockImplementation(() => envelope({ timeZone: "Asia/Dhaka", unitSystem: "metric", weightUnit: "kg" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}><PermissionProvider isSuperAdmin><StoreDefaultsCard /></PermissionProvider></QueryClientProvider>,
    ));
    const opener = await vi.waitFor(() => {
      const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Phone numbers accepted from"));
      expect(found).toBeDefined();
      return found!;
    });
    act(() => opener.click());
    const checkbox = await vi.waitFor(() => {
      const found = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes("Bangladesh"))?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(found).toBeDefined();
      return found!;
    });
    const save = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!;
    expect(save().disabled).toBe(true);
    act(() => checkbox.click());
    expect(save().disabled).toBe(false);
    act(() => checkbox.click());
    expect(save().disabled).toBe(true);
  });

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
    expect(note("business-phone")).toBe("Enter a number like 01712-345678 or 02-9876543, or a full number starting with +.");
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

  it("takes a Bangladesh landline, shows it as 02-9876543 and saves it as +880…", async () => {
    await openContactDialog(["BD"]);
    const phone = field("business-phone");

    type(phone, "০২ ৯৮৭ ৬৫৪৩");
    leave(phone);
    expect(phone.value).toBe("02-9876543");
    expect(note("business-phone")).toBe("Shown on invoices. Customers and couriers call this number.");

    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    await act(async () => { save.click(); });
    await vi.waitFor(() => expect(sdk.postApiV1AdminSettingsBusiness).toHaveBeenCalledOnce());
    expect(sdk.postApiV1AdminSettingsBusiness.mock.calls[0]![0].body).toMatchObject({ phone: "+88029876543" });
  });

  it("checks the invoice prefix length when the field is left, before Save", async () => {
    sdk.getApiV1AdminSettingsBusiness.mockImplementation(() => envelope(business));
    sdk.getApiV1AdminSettingsAllowedCountries.mockImplementation(() => envelope({ allowedCountries: [], allowedCountriesMode: "include" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Invoices"));
      expect(button).toBeDefined();
      return button!;
    });
    act(() => row.click());
    const prefix = await vi.waitFor(() => {
      expect(field("business-invoicePrefix")).not.toBeNull();
      return field("business-invoicePrefix");
    });

    type(prefix, "X".repeat(40));
    expect(note("business-invoicePrefix")).not.toContain("characters");
    leave(prefix);
    expect(note("business-invoicePrefix")).toBe("Use 32 characters or fewer.");

    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    await act(async () => { save.click(); });
    expect(sdk.postApiV1AdminSettingsBusiness).not.toHaveBeenCalled();
  });

  it("saves the store's social profiles, in order, through the business endpoint", async () => {
    sdk.getApiV1AdminSettingsBusiness.mockImplementation(() => envelope({
      ...business,
      socialLinks: [{ id: "fb", label: "Facebook", url: "https://facebook.com/dokan" }],
    }));
    sdk.getApiV1AdminSettingsAllowedCountries.mockImplementation(() => envelope({ allowedCountries: [], allowedCountriesMode: "include" }));
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
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Social profiles"));
      expect(button?.textContent).toContain("Facebook");
      return button!;
    });
    act(() => row.click());
    const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
    await vi.waitFor(() => expect(byId("business-socialLinks.0.url")).not.toBeNull());
    expect(byId("business-socialLinks.0.url").value).toBe("https://facebook.com/dokan");

    const add = [...document.querySelectorAll("button")].find((button) => button.textContent === "Add profile")!;
    act(() => add.click());
    type(byId("business-socialLinks.1.label"), "Instagram");
    type(byId("business-socialLinks.1.url"), "http://instagram.com/dokan");
    leave(byId("business-socialLinks.1.url"));
    expect(note("business-socialLinks\\.1\\.url")).toBe("Use the profile's full https:// address.");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    await act(async () => { save.click(); });
    expect(sdk.postApiV1AdminSettingsBusiness).not.toHaveBeenCalled();

    type(byId("business-socialLinks.1.url"), "https://instagram.com/dokan");
    await act(async () => { save.click(); });
    await vi.waitFor(() => expect(sdk.postApiV1AdminSettingsBusiness).toHaveBeenCalledOnce());
    expect(sdk.postApiV1AdminSettingsBusiness.mock.calls[0]![0].body.socialLinks).toEqual([
      { id: "fb", label: "Facebook", url: "https://facebook.com/dokan" },
      { id: expect.any(String), label: "Instagram", url: "https://instagram.com/dokan" },
    ]);
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
