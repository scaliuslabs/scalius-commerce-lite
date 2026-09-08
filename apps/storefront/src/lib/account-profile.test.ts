// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { escapeHtml } from "@scalius/shared/html-escape";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { getOrderPaymentPresentation } from "./order-success-state";
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
  zone: "zone_mirpur", zoneName: "Mirpur", area: "area_mirpur_1", areaName: "Mirpur 1",
};
const cities = [{ id: "city_dhaka", name: "Dhaka" }];
const zones = [{ id: "zone_mirpur", name: "Mirpur" }];
const areas = [{ id: "area_mirpur_1", name: "Mirpur 1" }];
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
const getAreas = vi.fn();
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
  getAreas.mockResolvedValue(areas);
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
        <div id="profileAreaField" hidden><select id="fieldArea" disabled><option value="">Area (optional)</option></select></div>
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
    getCustomerSession, getCustomerOrders, getCities, getZones, getAreas, updateCustomerProfile,
    logoutCustomer: vi.fn(), formatPhoneForDisplay, escapeHtml, DEFAULT_CURRENCY,
    getProductImageUrl: vi.fn(),
    getOrderPaymentPresentation, ENGLISH_CHECKOUT_LANGUAGE_DATA,
  };
  initializeAccountPage = new Function(...Object.keys(dependencies), `${script}\nreturn initializeAccountPage;`)(...Object.values(dependencies));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("account order payment presentation", () => {
  it.each([
    { status: "pending", paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 100, expected: "৳100 due on delivery", balanceLabel: "Due on delivery" },
    { status: "pending", paymentMethod: "cod", paymentStatus: "partial", paidAmount: 40, balanceDue: 60, expected: "৳60 due on delivery", balanceLabel: "Due on delivery" },
    { status: "cancelled", paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 100, expected: "No payment due", balanceLabel: null },
    { status: "cancelled", paymentMethod: "cod", paymentStatus: "partial", paidAmount: 40, balanceDue: 60, expected: "No payment due", balanceLabel: null },
    { status: "returned", paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 100, expected: "No payment due", balanceLabel: null },
    { status: "pending", paymentMethod: "cod", paymentStatus: "paid", paidAmount: 100, balanceDue: 0, expected: "Paid", balanceLabel: null },
    { status: "pending", paymentMethod: "sslcommerz", paymentStatus: "paid", paidAmount: 100, balanceDue: 0, expected: "Paid", balanceLabel: null },
    { status: "incomplete", paymentMethod: "sslcommerz", paymentStatus: "failed", paidAmount: 0, balanceDue: 100, expected: "Payment needs attention", balanceLabel: "Balance due" },
  ])("renders $status $paymentMethod $paymentStatus without inventing recovery eligibility", async (payment) => {
    const order = { ...oldOrder, ...payment };
    getCustomerOrders.mockResolvedValue({ success: true, orders: [order], customer });
    await initializeAccountPage();
    await vi.waitFor(() => expect(document.querySelector(".order-card")).not.toBeNull());
    const card = document.querySelector(".order-card")!;
    expect(card.textContent).toContain(payment.expected);
    expect(card.textContent).not.toContain("pay the remaining");
    expect(card.textContent).not.toContain("recovery options");
    const links = card.querySelectorAll(`a[href="/account/orders/${order.id}"]`);
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe("Full Timeline");
    (card.querySelector("[data-order-toggle]") as HTMLButtonElement).click();
    const quickView = card.querySelector(".order-details")!;
    expect(quickView.classList.contains("hidden")).toBe(false);
    if (payment.balanceLabel) expect(quickView.textContent).toContain(payment.balanceLabel);
    else expect(quickView.textContent).not.toMatch(/Due Amount|Balance due|Due on delivery/);
    if (payment.paidAmount > 0) expect(quickView.textContent).toContain(`৳${payment.paidAmount}`);
    if (payment.paymentMethod === "cod") {
      expect(card.textContent).toContain("Cash on delivery");
      expect(card.querySelector(".bg-amber-500\\/10")).toBeNull();
    } else expect(card.textContent).toContain("Online payment (SSLCommerz)");
  });
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
      name: "Updated name", address: customer.address, city: customer.city, zone: customer.zone, area: customer.area,
    }));
  });

  it.each([null, ""])("preserves intentional %s profile blanks instead of using order history", async (blank) => {
    getCustomerSession.mockResolvedValue({
      authenticated: true, customer: { ...customer, address: blank, city: blank, cityName: blank, zone: blank, zoneName: blank, area: blank, areaName: blank },
    });
    getCustomerOrders.mockResolvedValue({
      success: true, orders: [oldOrder], customer: { ...customer, name: "Old order customer", address: blank, city: blank, zone: blank },
    });
    await initializeAccountPage();
    await vi.waitFor(() => expect(element("orderCount").textContent).toBe("1 order"));
    expect(field("fieldAddress").value).toBe("");
    expect(field("fieldCity").value).toBe("");
    expect(field("fieldZone").value).toBe("");
    expect(field("fieldArea").value).toBe("");
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

  it("preserves the saved area through its initial read and an unrelated address save", async () => {
    const locations = deferred<typeof areas>();
    getAreas.mockReturnValueOnce(locations.promise);
    const initialization = initializeAccountPage();
    await vi.waitFor(() => expect(getAreas).toHaveBeenCalledWith(customer.zone));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    element("saveProfileBtn").click();
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    locations.resolve(areas);
    await initialization;
    expect(field("fieldArea").value).toBe(customer.area);
    expect(element("profileAreaField").hidden).toBe(false);
    field("fieldAddress").value = "New street address";
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: "New street address", city: customer.city, zone: customer.zone, area: customer.area,
    }));
  });

  it("clears descendants immediately and persists a new city, zone and optional area", async () => {
    getCities.mockResolvedValue([...cities, { id: "city_bagerhat", name: "Bagerhat" }]);
    await initializeAccountPage();
    const nextZones = deferred<typeof zones>();
    getZones.mockReturnValueOnce(nextZones.promise);
    field("fieldCity").value = "city_bagerhat";
    field("fieldCity").dispatchEvent(new Event("change"));
    expect(field("fieldZone").value).toBe("");
    expect(field("fieldArea").value).toBe("");
    expect(field("fieldArea").disabled).toBe(true);
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    nextZones.resolve([{ id: "zone_sadar", name: "Bagerhat Sadar" }]);
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    expect(element("profileSaveStatus").textContent).toContain("Choose a zone");
    const nextAreas = deferred<typeof areas>();
    getAreas.mockReturnValueOnce(nextAreas.promise);
    field("fieldZone").value = "zone_sadar";
    field("fieldZone").dispatchEvent(new Event("change"));
    expect(field("fieldArea").value).toBe("");
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    nextAreas.resolve([{ id: "area_school", name: "Adarsh school" }]);
    await vi.waitFor(() => expect(field("fieldArea").disabled).toBe(false));
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, city: "city_bagerhat", zone: "zone_sadar", area: "",
    }));
    await vi.waitFor(() => expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false));
    field("fieldArea").value = "area_school";
    field("fieldArea").dispatchEvent(new Event("change"));
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, city: "city_bagerhat", zone: "zone_sadar", area: "area_school",
    }));
    getCustomerSession.mockResolvedValue({ authenticated: true, customer: {
      ...customer, city: "city_bagerhat", zone: "zone_sadar", area: "area_school",
    } });
    getZones.mockResolvedValue([{ id: "zone_sadar", name: "Bagerhat Sadar" }]);
    getAreas.mockResolvedValue([{ id: "area_school", name: "Adarsh school" }]);
    await initializeAccountPage();
    expect(field("fieldArea").value).toBe("area_school");
  });

  it("submits an empty area when changing only the zone", async () => {
    getZones.mockResolvedValue([...zones, { id: "zone_central", name: "Central Road" }]);
    await initializeAccountPage();
    getAreas.mockResolvedValueOnce([]);
    field("fieldZone").value = "zone_central";
    field("fieldZone").dispatchEvent(new Event("change"));
    expect(field("fieldArea").value).toBe("");
    await vi.waitFor(() => expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false));
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, city: customer.city, zone: "zone_central", area: "",
    }));
  });

  it.each(["area", "city"])("submits an explicit %s clear and keeps it after reinitialization", async (clear) => {
    await initializeAccountPage();
    field(clear === "area" ? "fieldArea" : "fieldCity").value = "";
    field(clear === "area" ? "fieldArea" : "fieldCity").dispatchEvent(new Event("change"));
    expect(field("fieldArea").value).toBe("");
    const location = { city: clear === "city" ? "" : customer.city, zone: clear === "city" ? "" : customer.zone, area: "" };
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, ...location,
    }));
    getCustomerSession.mockResolvedValue({ authenticated: true, customer: { ...customer, ...location } });
    await initializeAccountPage();
    expect(field("fieldArea").value).toBe("");
    expect(field("fieldCity").value).toBe(location.city);
    expect(field("fieldZone").value).toBe(location.zone);
  });

  it.each(["cities", "zones", "areas"])("retries failed initial %s reads without erasing text edits", async (failure) => {
    if (failure === "cities") getCities.mockResolvedValueOnce(null);
    if (failure === "zones") getZones.mockResolvedValueOnce(null);
    if (failure === "areas") getAreas.mockResolvedValueOnce(null);
    await initializeAccountPage();
    element("profileToggle").click();
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    expect(field("fieldCity").disabled).toBe(failure === "cities");
    expect(field("fieldZone").disabled).toBe(failure !== "areas");
    expect(field("fieldArea").disabled).toBe(true);
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
    expect(field("fieldArea").value).toBe(customer.area);
    expect(getCities).toHaveBeenCalledTimes(failure === "cities" ? 2 : 1);
    expect(getZones).toHaveBeenCalledTimes(failure === "zones" ? 2 : 1);
    expect(getAreas).toHaveBeenCalledTimes(failure === "areas" ? 2 : 1);
    expect(getCustomerSession).toHaveBeenCalledTimes(1);
    expect(getCustomerOrders).toHaveBeenCalledTimes(1);
  });

  it.each(["zones", "areas"])("retries a failed edited %s selection without restoring the old profile", async (failure) => {
    getCities.mockResolvedValue([...cities, { id: "city_other", name: "Other city" }]);
    getZones.mockResolvedValue([...zones, { id: "zone_other", name: "Other zone" }]);
    await initializeAccountPage();
    field("fieldName").value = "Edited name";
    field("fieldAddress").value = "";
    if (failure === "zones") {
      getZones.mockResolvedValueOnce(null);
      field("fieldCity").value = "city_other";
      field("fieldCity").dispatchEvent(new Event("change"));
    } else {
      getAreas.mockResolvedValueOnce(null);
      field("fieldZone").value = "zone_other";
      field("fieldZone").dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(false));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    expect(field("fieldArea").value).toBe("");
    element("profileLocationsRetryBtn").click();
    await vi.waitFor(() => expect(field(failure === "zones" ? "fieldZone" : "fieldArea").disabled).toBe(false));
    expect(field("fieldCity").value).toBe(failure === "zones" ? "city_other" : customer.city);
    expect(field("fieldZone").value).toBe(failure === "zones" ? "" : "zone_other");
    expect(field("fieldArea").value).toBe("");
    expect(field("fieldName").value).toBe("Edited name");
    expect(field("fieldAddress").value).toBe("");
    expect(getCities).toHaveBeenCalledOnce();
    expect(getZones).toHaveBeenCalledTimes(failure === "zones" ? 3 : 1);
    expect(getAreas).toHaveBeenCalledTimes(failure === "areas" ? 3 : 1);
    expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(true);
  });

  it.each(["city", "zone"])("requires an explicit replacement or clear for an unavailable saved %s", async (missing) => {
    if (missing === "city") getCities.mockResolvedValue([{ id: "city_active", name: "Active city" }]);
    getZones.mockResolvedValue([{ id: "zone_active", name: "Active zone" }]);
    await initializeAccountPage();
    expect(field("fieldCity").value).toBe(customer.city);
    expect(field("fieldZone").value).toBe(customer.zone);
    expect(field("fieldArea").value).toBe(customer.area);
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
    await vi.waitFor(() => expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false));
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: "New name", address: customer.address,
      city: missing === "city" ? "city_active" : customer.city, zone: "zone_active", area: "",
    }));
  });

  it.each(["", "area_active"])("preserves an unavailable area until the buyer chooses %s", async (replacement) => {
    getAreas.mockResolvedValue([{ id: "area_active", name: "Active area" }]);
    await initializeAccountPage();
    expect(field("fieldArea").value).toBe(customer.area);
    expect(element<HTMLSelectElement>("fieldArea").selectedOptions[0]?.disabled).toBe(true);
    expect(element("profileSaveStatus").textContent).toContain("no longer available");
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    field("fieldArea").value = replacement;
    field("fieldArea").dispatchEvent(new Event("change"));
    element("saveProfileBtn").click();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, city: customer.city, zone: customer.zone, area: replacement,
    }));
  });

  it.each(["", "area_retired"])("hides an empty area list unless saved area %s needs repair", async (savedArea) => {
    getCustomerSession.mockResolvedValue({ authenticated: true, customer: { ...customer, area: savedArea } });
    getAreas.mockResolvedValue([]);
    await initializeAccountPage();
    expect(element("profileAreaField").hidden).toBe(!savedArea);
    expect(field("fieldArea").value).toBe(savedArea);
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(Boolean(savedArea));
    if (savedArea) {
      expect(element("profileSaveStatus").textContent).toContain("no longer available");
      field("fieldArea").value = "";
      field("fieldArea").dispatchEvent(new Event("change"));
      expect(element("profileAreaField").hidden).toBe(true);
      expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false);
    }
  });

  it("explains an empty zone list and allows the buyer to clear the full location", async () => {
    await initializeAccountPage();
    getZones.mockResolvedValueOnce([]);
    field("fieldCity").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    expect(element("profileSaveStatus").textContent).toContain("No zones are available");
    field("fieldCity").value = "";
    field("fieldCity").dispatchEvent(new Event("change"));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false);
    expect(element("profileSaveStatus").classList.contains("hidden")).toBe(true);
  });

  it("keeps only the latest zones when rapid city changes return to the same city", async () => {
    getCities.mockResolvedValue([...cities, { id: "city_other", name: "Other city" }]);
    await initializeAccountPage();
    const reads = [deferred<typeof zones | null>(), deferred<typeof zones | null>(), deferred<typeof zones | null>()];
    reads.forEach((read) => getZones.mockReturnValueOnce(read.promise));
    for (const city of ["city_other", customer.city!, "city_other"]) {
      field("fieldCity").value = city;
      field("fieldCity").dispatchEvent(new Event("change"));
    }
    reads[2]!.resolve([{ id: "zone_latest", name: "Latest zone" }]);
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    field("fieldZone").value = "zone_latest";
    field("fieldZone").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(field("fieldArea").disabled).toBe(false));
    reads[0]!.resolve([{ id: "zone_old", name: "Old zone" }]);
    reads[1]!.resolve(null);
    await Promise.all(reads.map((read) => read.promise));
    expect(Array.from(element<HTMLSelectElement>("fieldZone").options, (option) => option.value)).toEqual(["", "zone_latest"]);
    expect(field("fieldZone").value).toBe("zone_latest");
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false);
    expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(true);

    const beforeClear = deferred<typeof zones>();
    getZones.mockReturnValueOnce(beforeClear.promise);
    field("fieldCity").dispatchEvent(new Event("change"));
    field("fieldCity").value = "";
    field("fieldCity").dispatchEvent(new Event("change"));
    beforeClear.resolve(zones);
    await beforeClear.promise;
    expect(element<HTMLSelectElement>("fieldZone").options).toHaveLength(1);
    expect(field("fieldZone").disabled).toBe(true);
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false);
  });

  it("keeps only the latest areas when rapid zone changes return to the same zone", async () => {
    getZones.mockResolvedValue([...zones, { id: "zone_other", name: "Other zone" }]);
    await initializeAccountPage();
    const reads = [deferred<typeof areas | null>(), deferred<typeof areas | null>(), deferred<typeof areas | null>()];
    reads.forEach((read) => getAreas.mockReturnValueOnce(read.promise));
    for (const zone of ["zone_other", customer.zone!, "zone_other"]) {
      field("fieldZone").value = zone;
      field("fieldZone").dispatchEvent(new Event("change"));
    }
    reads[2]!.resolve([{ id: "area_latest", name: "Latest area" }]);
    await vi.waitFor(() => expect(field("fieldArea").disabled).toBe(false));
    field("fieldArea").value = "area_latest";
    field("fieldArea").dispatchEvent(new Event("change"));
    reads[0]!.resolve(null);
    reads[1]!.resolve(areas);
    await Promise.all(reads.map((read) => read.promise));
    expect(Array.from(element<HTMLSelectElement>("fieldArea").options, (option) => option.value)).toEqual(["", "area_latest"]);
    expect(field("fieldArea").value).toBe("area_latest");
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false);
    expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(true);
  });

  it.each(["fieldCity", "fieldZone"])("ignores pending areas after clearing %s", async (parent) => {
    await initializeAccountPage();
    const locations = deferred<typeof areas>();
    getAreas.mockReturnValueOnce(locations.promise);
    field("fieldZone").dispatchEvent(new Event("change"));
    field(parent).value = "";
    field(parent).dispatchEvent(new Event("change"));
    locations.resolve(areas);
    await locations.promise;
    expect(field("fieldArea").value).toBe("");
    expect(field("fieldArea").disabled).toBe(true);
    expect(element<HTMLSelectElement>("fieldArea").options).toHaveLength(1);
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(parent === "fieldZone");
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
    await vi.waitFor(() => expect(element("saveProfileBtn").textContent).toBe("Save Address"));
    expect(element("profileSaveStatus").textContent).toContain("Loading delivery locations");
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    locations.resolve(zones);
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    field("fieldZone").value = customer.zone!;
    field("fieldZone").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(false));
  });

  it.each([true, false])("preserves a new location failure when an earlier save settles with success=%s", async (success) => {
    await initializeAccountPage();
    const save = deferred<{ success: boolean; error?: string }>();
    updateCustomerProfile.mockReturnValueOnce(save.promise);
    element("profileSaveStatus").textContent = "Previous message";
    element("saveProfileBtn").click();
    expect(element("profileSaveStatus").textContent).toBe("");
    expect(element("profileSaveStatus").classList.contains("hidden")).toBe(true);
    getAreas.mockResolvedValueOnce(null);
    field("fieldZone").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(false));
    save.resolve({ success, error: success ? undefined : "Profile could not be saved." });
    await vi.waitFor(() => expect(element("saveProfileBtn").textContent).toBe("Save Address"));
    expect(element<HTMLButtonElement>("saveProfileBtn").disabled).toBe(true);
    expect(element("profileSaveStatus").textContent).toContain("Your delivery locations could not be loaded. Try again before saving.");
    expect(element("profileSaveStatus").classList.contains("hidden")).toBe(false);
    expect(element("profileSaveStatus").classList.contains("text-primary")).toBe(false);
    if (!success) expect(element("profileSaveStatus").textContent).toContain("Profile could not be saved.");
  });

  it.each(["zones", "areas"])("ignores an older %s initialization after a new account run", async (stage) => {
    const locations = deferred<typeof zones>();
    const readLocations = stage === "zones" ? getZones : getAreas;
    readLocations.mockReturnValueOnce(locations.promise);
    const firstInitialization = initializeAccountPage();
    await vi.waitFor(() => expect(readLocations).toHaveBeenCalledOnce());
    getCustomerSession.mockResolvedValueOnce({
      authenticated: true, customer: { ...customer, city: null, zone: null, area: null, cityName: null, zoneName: null, areaName: null },
    });
    getCustomerOrders.mockResolvedValueOnce({ success: true, orders: [] });
    await initializeAccountPage();
    locations.resolve(zones);
    await firstInitialization;
    expect(field("fieldCity").value).toBe("");
    expect(field("fieldZone").value).toBe("");
    expect(field("fieldZone").disabled).toBe(true);
    expect(field("fieldArea").value).toBe("");
    expect(field("fieldArea").disabled).toBe(true);
  });
});
