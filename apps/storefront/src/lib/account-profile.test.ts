// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { escapeHtml } from "@scalius/shared/html-escape";
import type { CustomerInfo, CustomerOrder, getCustomerOrders as readOrders } from "./api/customer-auth";
import { storefrontSourcePath } from "./test-source-paths";

// Exercise the real account initialization and DOM handlers without registering
// page-wide navigation listeners or making network requests.
const source = readFileSync(storefrontSourcePath("pages", "account.astro"), "utf8");
const scriptSource = source.split("<script>")[1]!.split("  if (!accountWindow.__scaliusAccountPageBound)")[0]!;
const parsedScript = ts.createSourceFile("account.ts", scriptSource, ts.ScriptTarget.ES2022, true);
const script = ts.transpileModule(
  parsedScript.statements.filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getFullText(parsedScript)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;

const customer: CustomerInfo = {
  name: "Current customer", email: "customer@example.test", phone: "+8801712345678",
  address: "Current delivery address", city: "city_dhaka", cityName: "Dhaka",
  zone: "zone_mirpur", zoneName: "Mirpur", area: null,
};
const cities = [{ id: "city_dhaka", name: "Dhaka" }];
const zones = [{ id: "zone_mirpur", name: "Mirpur" }];
const oldOrder: CustomerOrder = {
  id: "order_previous", status: "delivered", totalAmount: 100, paidAmount: 100, balanceDue: 0,
  shippingCharge: 0, shippingMethodId: null, shippingMethodName: null, shippingMethodDescription: null,
  shippingMethodBaseAmountMinor: null, shippingFeeWaived: null, discountAmount: null,
  paymentStatus: "paid", paymentMethod: "cod", fulfillmentStatus: "delivered",
  shippingAddress: "Previous order address", cityName: "Dhaka", zoneName: "Mirpur",
  areaName: null, notes: null, createdAt: null, latestShipment: null, items: [],
};
type OrdersResult = Awaited<ReturnType<typeof readOrders>>;
const ordersFailure: OrdersResult = { success: false, orders: [], unavailable: true, error: "Order history is temporarily unavailable." };
const getCustomerSession = vi.fn();
const getCustomerOrders = vi.fn();
const getCities = vi.fn();
const getZones = vi.fn();
const updateCustomerProfile = vi.fn();
let initializeAccountPage: () => Promise<void>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function element<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}

function field(id: string) {
  return element<HTMLInputElement | HTMLSelectElement>(id);
}

beforeEach(() => {
  vi.resetAllMocks();
  getCustomerSession.mockResolvedValue({ authenticated: true, customer });
  getCustomerOrders.mockResolvedValue({ success: true, orders: [], customer });
  getCities.mockResolvedValue(cities);
  getZones.mockResolvedValue(zones);
  updateCustomerProfile.mockResolvedValue({ success: true, customer });
  document.body.innerHTML = `<main data-account-page>
    <div id="loadingState"></div><div id="unauthState" class="hidden"></div>
    <div id="accountError" class="hidden"><span id="accountErrorMessage"></span><button id="accountRetryBtn">Retry account</button></div>
    <div id="authState" class="hidden">
      <span id="profileAvatar"></span><span id="profileName"></span><span id="profileEmail"></span><span id="profilePhone"></span>
      <button id="profileToggle">Edit</button><span id="profileChevron"></span>
      <div id="profileForm" class="hidden">
        <input id="fieldName" /><input id="fieldPhone" disabled /><input id="fieldAddress" />
        <select id="fieldCity"><option value="">City</option></select>
        <select id="fieldZone" disabled><option value="">Zone</option></select>
        <button id="saveProfileBtn" disabled>Save Address</button><p id="profileSaveStatus" class="hidden"></p>
        <button id="profileLocationsRetryBtn" class="hidden">Retry delivery locations</button>
      </div>
      <span id="statTotalOrders"></span><span id="statTotalSpent"></span><span id="orderCount"></span>
      <div id="ordersList"></div><div id="emptyOrders" class="hidden"></div>
      <div id="ordersError" class="hidden"><span id="ordersErrorMessage"></span><button id="ordersRetryBtn">Try Again</button></div>
      <div id="showMoreContainer" class="hidden"><button id="showMoreBtn"><span id="showMoreText"></span></button></div>
      <button id="logoutBtn">Sign out</button>
    </div>
  </main>`;
  const dependencies = {
    getCustomerSession, getCustomerOrders, getCities, getZones, updateCustomerProfile,
    logoutCustomer: vi.fn(), formatPhoneForDisplay, escapeHtml, DEFAULT_CURRENCY,
    getProductImageUrl: vi.fn(),
  };
  initializeAccountPage = new Function(...Object.keys(dependencies), `${script}\nreturn initializeAccountPage;`)(...Object.values(dependencies));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("account delivery profile authority", () => {
  it("makes the saved profile editable while orders are pending and preserves it through failure and save", async () => {
    const orders = deferred<OrdersResult>();
    getCustomerOrders.mockReturnValueOnce(orders.promise);
    const initialization = initializeAccountPage();

    await vi.waitFor(() => expect(field("fieldCity").value).toBe(customer.city));
    await vi.waitFor(() => expect(field("fieldZone").value).toBe(customer.zone));
    element("profileToggle").click();
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
    expect(field("fieldName").value).toBe(customer.name);
    expect(field("fieldPhone").value).toBe(customer.phone);
    expect(field("fieldAddress").value).toBe(customer.address);

    orders.resolve(ordersFailure);
    await initialization;
    await vi.waitFor(() => expect(element("ordersError").classList.contains("hidden")).toBe(false));
    field("fieldName").value = "Updated name";
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: "Updated name", address: customer.address, city: customer.city, zone: customer.zone,
    }));
  });

  it.each([null, ""])("preserves intentional %s profile blanks instead of using order history", async (blank) => {
    getCustomerSession.mockResolvedValue({
      authenticated: true, customer: { ...customer, address: blank, city: blank, cityName: blank, zone: blank, zoneName: blank },
    });
    getCustomerOrders.mockResolvedValue({
      success: true, orders: [oldOrder], customer: { ...customer, name: "Old order customer", address: blank, city: blank, zone: blank },
    });
    await initializeAccountPage();
    await vi.waitFor(() => expect(element("orderCount").textContent).toBe("1 order"));
    expect(field("fieldAddress").value).toBe("");
    expect(field("fieldCity").value).toBe("");
    expect(field("fieldZone").value).toBe("");
    expect(field("fieldName").value).toBe(customer.name);
    expect(field("fieldPhone").value).toBe(customer.phone);
  });

  it("retries only order history without replacing an open delivery draft or an explicit clear", async () => {
    getCustomerOrders.mockResolvedValueOnce(ordersFailure);
    await initializeAccountPage();
    element("profileToggle").click();
    field("fieldName").value = "Unsaved name";
    field("fieldAddress").value = "";
    const retry = deferred<OrdersResult>();
    getCustomerOrders.mockReturnValueOnce(retry.promise);
    element("ordersRetryBtn").click();
    await vi.waitFor(() => expect(getCustomerOrders).toHaveBeenCalledTimes(2));
    expect(element("authState").classList.contains("hidden")).toBe(false);
    retry.resolve({ success: true, orders: [oldOrder], customer });
    await vi.waitFor(() => expect(element("orderCount").textContent).toBe("1 order"));

    expect(getCustomerSession).toHaveBeenCalledTimes(1);
    expect(getCities).toHaveBeenCalledTimes(1);
    expect(getZones).toHaveBeenCalledTimes(1);
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
    expect(field("fieldName").value).toBe("Unsaved name");
    expect(field("fieldAddress").value).toBe("");
    expect(field("fieldCity").value).toBe(customer.city);
    expect(field("fieldZone").value).toBe(customer.zone);
  });

  it("keeps Save unavailable until initial location values are bound", async () => {
    const locations = deferred<typeof zones>();
    getZones.mockReturnValueOnce(locations.promise);
    const initialization = initializeAccountPage();
    await vi.waitFor(() => expect(getZones).toHaveBeenCalledOnce());
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    element("saveProfileBtn").click();
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    locations.resolve(zones);
    await initialization;
    expect(field("fieldCity").value).toBe(customer.city);
    expect(field("fieldZone").value).toBe(customer.zone);
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false);
  });

  it.each(["cities", "zones"])("retries failed initial %s reads without erasing text edits", async (failure) => {
    if (failure === "cities") getCities.mockResolvedValueOnce(null);
    if (failure === "zones") getZones.mockResolvedValueOnce(null);
    await initializeAccountPage();
    element("profileToggle").click();
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    expect(field("fieldCity").disabled).toBe(true);
    expect(field("fieldZone").disabled).toBe(true);
    expect(element("profileSaveStatus").textContent).toContain("Try again before saving");
    expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(false);
    field("fieldName").value = "Unsaved name";
    field("fieldAddress").value = "";
    element("profileLocationsRetryBtn").click();
    await vi.waitFor(() => expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false));

    expect(field("fieldName").value).toBe("Unsaved name");
    expect(field("fieldAddress").value).toBe("");
    expect(field("fieldCity").value).toBe(customer.city);
    expect(field("fieldZone").value).toBe(customer.zone);
    expect(getCustomerSession).toHaveBeenCalledTimes(1);
    expect(getCustomerOrders).toHaveBeenCalledTimes(1);
  });

  it.each(["city", "zone"])("requires an explicit replacement or clear for an unavailable saved %s", async (missing) => {
    if (missing === "city") getCities.mockResolvedValue([{ id: "city_active", name: "Active city" }]);
    getZones.mockResolvedValue([{ id: "zone_active", name: "Active zone" }]);
    await initializeAccountPage();
    expect(field("fieldCity").value).toBe(customer.city);
    expect(field("fieldZone").value).toBe(customer.zone);
    expect(field("fieldCity").disabled).toBe(false);
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    expect(element("profileSaveStatus").textContent).toContain("no longer available");
    expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(true);
    field("fieldName").value = "New name";
    element("saveProfileBtn").click();
    expect(updateCustomerProfile).not.toHaveBeenCalled();

    if (missing === "city") {
      expect(getZones).not.toHaveBeenCalled();
      field("fieldCity").value = "city_active";
      field("fieldCity").dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    }
    field("fieldZone").value = "zone_active";
    field("fieldZone").dispatchEvent(new Event("change"));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false);
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: "New name", address: customer.address,
      city: missing === "city" ? "city_active" : customer.city, zone: "zone_active",
    }));
  });

  it("does not enable a second save when location controls change during a pending save", async () => {
    await initializeAccountPage();
    const save = deferred<{ success: boolean }>();
    updateCustomerProfile.mockReturnValueOnce(save.promise);
    element("saveProfileBtn").click();
    field("fieldZone").dispatchEvent(new Event("change"));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    element("saveProfileBtn").click();
    expect(updateCustomerProfile).toHaveBeenCalledTimes(1);

    const locations = deferred<typeof zones>();
    getZones.mockReturnValueOnce(locations.promise);
    field("fieldCity").dispatchEvent(new Event("change"));
    save.resolve({ success: true });
    await vi.waitFor(() => expect(element("profileSaveStatus").textContent).toContain("successfully"));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    locations.resolve(zones);
    await vi.waitFor(() => expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false));
  });

  it("ignores an older location initialization after a new account run", async () => {
    const locations = deferred<typeof zones>();
    getZones.mockReturnValueOnce(locations.promise);
    const firstInitialization = initializeAccountPage();
    await vi.waitFor(() => expect(getZones).toHaveBeenCalledOnce());
    getCustomerSession.mockResolvedValueOnce({
      authenticated: true, customer: { ...customer, city: null, zone: null, cityName: null, zoneName: null },
    });
    getCustomerOrders.mockResolvedValueOnce({ success: true, orders: [] });
    await initializeAccountPage();
    locations.resolve(zones);
    await firstInitialization;
    expect(field("fieldCity").value).toBe("");
    expect(field("fieldZone").value).toBe("");
    expect(field("fieldZone").disabled).toBe(true);
  });
});
