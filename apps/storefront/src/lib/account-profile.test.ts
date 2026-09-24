// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerInfo, getCustomerOrders as readOrders } from "./api/customer-auth";
import type { AccountOrder } from "./account-page";

const api = vi.hoisted(() => ({
  getCustomerSession: vi.fn(),
  getCustomerOrders: vi.fn(),
  updateCustomerProfile: vi.fn(),
  logoutCustomer: vi.fn(),
  sendGuestOrdersCode: vi.fn(),
  verifyGuestOrders: vi.fn(),
  getCities: vi.fn(),
  getZones: vi.fn(),
  getAreas: vi.fn(),
}));
vi.mock("./api/customer-auth", () => ({
  getCustomerSession: api.getCustomerSession,
  getCustomerOrders: api.getCustomerOrders,
  updateCustomerProfile: api.updateCustomerProfile,
  logoutCustomer: api.logoutCustomer,
  sendGuestOrdersCode: api.sendGuestOrdersCode,
  verifyGuestOrders: api.verifyGuestOrders,
}));
vi.mock("./api/shipping", () => ({ getCities: api.getCities, getZones: api.getZones, getAreas: api.getAreas }));
vi.mock("./product-media", () => ({ getProductImageUrl: () => "/placeholder-product.svg" }));

const { bindSignOut, initializeAccountPage } = await import("./account-page");
const { getCustomerSession, getCustomerOrders, updateCustomerProfile, getCities, getZones, getAreas } = api;

const customer: CustomerInfo = {
  name: "Current customer", email: "customer@example.test", phone: "+8801712345678",
  address: "Current delivery address", city: "city_dhaka", cityName: "Dhaka",
  zone: "zone_mirpur", zoneName: "Mirpur", area: "area_mirpur_1", areaName: "Mirpur 1",
};
const cities = [{ id: "city_dhaka", name: "Dhaka" }];
const zones = [{ id: "zone_mirpur", name: "Mirpur" }];
const areas = [{ id: "area_mirpur_1", name: "Mirpur 1" }];
const oldOrder: AccountOrder = {
  id: "order_previous", status: "delivered", statusLabel: "Delivered", currencyCode: "BDT", openSupportRequestType: null, totalAmount: 100, paidAmount: 100, balanceDue: 0,
  shippingCharge: 0, shippingMethodId: null, shippingMethodName: null, shippingMethodDescription: null,
  shippingMethodBaseAmountMinor: null, shippingFeeWaived: null, discountAmount: null,
  paymentStatus: "paid", paymentMethod: "cod", fulfillmentStatus: "delivered",
  shippingAddress: "Previous order address", cityName: "Dhaka", zoneName: "Mirpur",
  areaName: null, notes: null, createdAt: "2026-09-23T23:46:00.000Z", latestShipment: null, items: [],
};
type OrdersResult = Awaited<ReturnType<typeof readOrders>>;
const ordersFailure: OrdersResult = { success: false, orders: [], unavailable: true, status: 502, error: "Proxy error" };

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

function saveButton() {
  return element<HTMLButtonElement>("saveProfileBtn");
}

function save() {
  element<HTMLFormElement>("profileForm").dispatchEvent(new Event("submit", { cancelable: true }));
}

function change(id: string, value?: string) {
  if (value !== undefined) field(id).value = value;
  field(id).dispatchEvent(new Event("change"));
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
    <div id="accountError" class="hidden"><button id="accountRetryBtn">Retry</button></div>
    <div id="authState" class="hidden">
      <form id="signOutForm"><button type="submit">Sign out</button></form>
      <span id="profileName"></span><span id="profileEmail"></span><span id="profilePhone"></span>
      <button id="nameToggle">Edit</button><p id="nameSaved" class="hidden">Name saved</p>
      <form id="nameForm" class="hidden">
        <input id="fieldProfileName" /><p id="fieldProfileNameError" class="hidden"></p>
        <p id="nameSaveStatus"></p><button id="saveNameBtn" type="submit">Save name</button>
      </form>
      <button id="profileToggle">Edit</button><div id="profileSummary"></div><p id="profileSaved" class="hidden">Address saved</p>
      <form id="profileForm" class="hidden">
        <input id="fieldName" /><p id="fieldNameError" class="hidden"></p>
        <input id="fieldAddress" /><p id="fieldAddressError" class="hidden"></p>
        <select id="fieldCity"><option value="">City</option></select><p id="fieldCityError" class="hidden"></p>
        <select id="fieldZone" disabled><option value="">Zone</option></select><p id="fieldZoneError" class="hidden"></p>
        <div id="profileAreaField" hidden><select id="fieldArea" disabled><option value="">Area (optional)</option></select></div>
        <p id="profileSaveStatus" class="hidden"></p>
        <button id="profileLocationsRetryBtn" type="button" class="hidden">Retry</button>
        <button id="saveProfileBtn" type="submit" disabled>Save address</button>
      </form>
      <h2 id="ordersHeading" tabindex="-1">Orders</h2><span id="orderCount"></span>
      <p id="guestOrdersStatus" role="status"></p><div id="guestOrderNotices" class="hidden"></div>
      <div id="ordersList"></div><div id="emptyOrders" class="hidden"></div>
      <div id="ordersError" class="hidden"><span id="ordersErrorMessage"></span><button id="ordersRetryBtn">Retry</button></div>
      <div id="showMoreContainer" class="hidden"><button id="showMoreBtn">Show more orders</button><p id="showMoreError"></p></div>
    </div>
  </main>`;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("account order history", () => {
  it.each([
    { status: "pending", paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 100, expected: "Cash on delivery · ৳100 due on delivery", balanceLabel: "Due on delivery" },
    { status: "pending", paymentMethod: "cod", paymentStatus: "partial", paidAmount: 40, balanceDue: 60, expected: "Cash on delivery · ৳60 due on delivery", balanceLabel: "Due on delivery" },
    { status: "cancelled", paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 100, expected: "Cash on delivery · No payment due", balanceLabel: null },
    { status: "returned", paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 100, expected: "Cash on delivery · No payment due", balanceLabel: null },
    { status: "pending", paymentMethod: "cod", paymentStatus: "paid", paidAmount: 100, balanceDue: 0, expected: "Cash on delivery · Paid", balanceLabel: null },
    { status: "pending", paymentMethod: "sslcommerz", paymentStatus: "paid", paidAmount: 100, balanceDue: 0, expected: "Online payment (SSLCommerz) · Paid", balanceLabel: null },
    { status: "incomplete", paymentMethod: "sslcommerz", paymentStatus: "failed", paidAmount: 0, balanceDue: 100, expected: "Online payment (SSLCommerz) · Payment needs attention", balanceLabel: "Balance due" },
  ])("shows one payment line for $status $paymentMethod $paymentStatus", async (payment) => {
    const order = { ...oldOrder, ...payment };
    getCustomerOrders.mockResolvedValue({ success: true, orders: [order], customer });
    await initializeAccountPage();
    const card = document.querySelector(".order-card")!;
    expect(card.textContent).toContain(payment.expected);
    const links = card.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(`/account/orders/${order.id}`);
    expect(links[0]?.textContent).toBe("Order #order_previous");
    const toggle = card.querySelector<HTMLButtonElement>("[data-order-toggle]")!;
    toggle.click();
    expect(toggle.textContent).toBe("Hide details");
    const quickView = card.querySelector(".order-details")!;
    expect(quickView.classList.contains("hidden")).toBe(false);
    if (payment.balanceLabel) expect(quickView.textContent).toContain(payment.balanceLabel);
    else expect(quickView.textContent).not.toMatch(/Balance due|Due on delivery/);
  });

  it("names the order by number, groups money in lakh and flags an open cancellation request", async () => {
    getCustomerOrders.mockResolvedValue({
      success: true,
      customer,
      orders: [{
        ...oldOrder, status: "confirmed", statusLabel: "Confirmed", orderNumber: 1001, totalAmount: 230690,
        paymentStatus: "unpaid", paidAmount: 0, balanceDue: 230690, shippingCharge: 80,
        openSupportRequestType: "cancel_pre_shipment", areaName: "Mirpur 1",
        items: [{ productId: "p1", variantId: null, quantity: 2, price: 1180, productName: "Tee", productSlug: "tee", productImage: null, variantLabel: null }],
      }],
    });
    await initializeAccountPage();
    const card = document.querySelector(".order-card")!;
    expect(card.querySelector("a")?.textContent).toBe("Order #1001");
    expect(card.textContent).toContain("24 Sep 2026 · 2 items");
    expect(card.textContent).toContain("৳2,30,690");
    expect(card.textContent).toContain("Confirmed");
    expect(card.textContent).toContain("Cancellation requested");
    expect(card.textContent).not.toMatch(/BDT|Standard/);
    expect(card.querySelector(".order-details")?.textContent).toContain("Delivering to: Previous order address, Mirpur 1, Mirpur, Dhaka");
  });

  it("says the store could not be reached instead of a raw proxy error, and retries only orders", async () => {
    getCustomerOrders.mockResolvedValueOnce(ordersFailure);
    await initializeAccountPage();
    expect(element("ordersErrorMessage").textContent).toBe("We couldn't reach the store. Check your connection and try again.");
    element("profileToggle").click();
    field("fieldName").value = "Unsaved name";
    const retry = deferred<OrdersResult>();
    getCustomerOrders.mockReturnValueOnce(retry.promise);
    element("ordersRetryBtn").click();
    await vi.waitFor(() => expect(getCustomerOrders).toHaveBeenCalledTimes(2));
    retry.resolve({ success: true, orders: [oldOrder], customer });
    await vi.waitFor(() => expect(element("orderCount").textContent).toBe("1 order"));
    expect(getCustomerSession).toHaveBeenCalledTimes(1);
    expect(getCities).toHaveBeenCalledTimes(1);
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
    expect(field("fieldName").value).toBe("Unsaved name");
  });

  it("offers to verify the phone behind guest orders and reloads the orders once they move", async () => {
    const guest = { id: "cust_guest_1", destination: "01•••••011", orderCount: 1, canVerify: true };
    getCustomerOrders
      .mockResolvedValueOnce({ success: true, orders: [], customer, unclaimedGuestOrders: [guest] })
      .mockResolvedValueOnce({ success: true, orders: [oldOrder], customer, unclaimedGuestOrders: [] });
    api.sendGuestOrdersCode.mockResolvedValue({ success: true, message: "We sent a code to 01•••••011.", destination: "01•••••011", resendAfterSeconds: 60 });
    api.verifyGuestOrders.mockResolvedValue({ success: true, movedOrders: 1, message: "1 order was added to your account." });
    await initializeAccountPage();

    const notices = element("guestOrderNotices");
    expect(notices.classList.contains("hidden")).toBe(false);
    expect(notices.textContent).toContain("1 more order was placed with 01•••••011. Verify this phone to add it.");
    [...notices.querySelectorAll("button")].find((button) => button.textContent === "Verify this phone")!.click();
    await vi.waitFor(() => expect(notices.querySelector("form")?.classList.contains("hidden")).toBe(false));
    notices.querySelector<HTMLInputElement>("input[name=code]")!.value = "123456";
    notices.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));

    await vi.waitFor(() => expect(element("orderCount").textContent).toBe("1 order"));
    expect(getCustomerOrders).toHaveBeenCalledTimes(2);
    expect(notices.classList.contains("hidden")).toBe(true);
    expect(notices.textContent).toBe("");
    expect(element("guestOrdersStatus").textContent).toBe("1 order was added to your account.");
    expect(document.activeElement).toBe(element("ordersHeading"));
    expect(getCustomerSession).toHaveBeenCalledTimes(1);
  });

  it("signs out through the logout route and tells the page to drop the checkout draft", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const loggedOut = vi.fn();
    window.addEventListener("customer-logout", loggedOut);
    bindSignOut();
    element<HTMLFormElement>("signOutForm").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(api.logoutCustomer).toHaveBeenCalledOnce();
    expect(loggedOut).toHaveBeenCalledOnce();
    window.removeEventListener("customer-logout", loggedOut);
  });
});

describe("account profile name", () => {
  it("edits the account name on its own and never touches the address", async () => {
    const renamed = { ...customer, name: "Rahim Uddin" };
    updateCustomerProfile.mockResolvedValueOnce({ success: true, customer: renamed });
    await initializeAccountPage();
    expect(element("nameToggle").textContent).toBe("Edit");
    element("nameToggle").click();
    expect(element("nameForm").classList.contains("hidden")).toBe(false);
    expect(element("nameToggle").textContent).toBe("Cancel");
    expect(field("fieldProfileName").value).toBe(customer.name);
    expect(document.activeElement).toBe(field("fieldProfileName"));

    field("fieldProfileName").value = " ";
    element<HTMLFormElement>("nameForm").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(element("fieldProfileNameError").textContent).toBe("Enter your full name.");
    expect(updateCustomerProfile).not.toHaveBeenCalled();

    field("fieldProfileName").value = " Rahim Uddin ";
    element<HTMLFormElement>("nameForm").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(element("nameSaved").classList.contains("hidden")).toBe(false));
    expect(updateCustomerProfile).toHaveBeenCalledWith({ name: "Rahim Uddin" });
    expect(element("profileName").textContent).toBe("Rahim Uddin");
    expect(element("nameForm").classList.contains("hidden")).toBe(true);
    expect(field("fieldName").value).toBe("Rahim Uddin");
  });

  it("keeps the typed name and says the store could not be reached", async () => {
    updateCustomerProfile.mockResolvedValueOnce({ success: false, unavailable: true, status: 502, error: "Proxy error" });
    await initializeAccountPage();
    element("nameToggle").click();
    field("fieldProfileName").value = "Draft name";
    element<HTMLFormElement>("nameForm").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(element("nameSaveStatus").textContent).toBe("We couldn't reach the store. Check your connection and try again."));
    expect(field("fieldProfileName").value).toBe("Draft name");
    expect(element("profileName").textContent).toBe(customer.name);
  });
});

describe("account delivery details", () => {
  it("shows the saved address collapsed and turns Edit into Cancel while editing", async () => {
    await initializeAccountPage();
    expect(element("profilePhone").textContent).toBe("01712-345678");
    expect(element("profileSummary").textContent).toBe("Current customerCurrent delivery addressMirpur 1, Mirpur, Dhaka");
    expect(element("profileToggle").textContent).toBe("Edit");
    element("profileToggle").click();
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
    expect(element("profileToggle").textContent).toBe("Cancel");
    field("fieldName").value = "Discarded";
    element("profileToggle").click();
    expect(element("profileForm").classList.contains("hidden")).toBe(true);
    expect(field("fieldName").value).toBe(customer.name);
  });

  it.each([null, ""])("offers Add address when the saved address is %s", async (blank) => {
    getCustomerSession.mockResolvedValue({
      authenticated: true, customer: { ...customer, address: blank, city: blank, cityName: blank, zone: blank, zoneName: blank, area: blank, areaName: blank },
    });
    getCustomerOrders.mockResolvedValue({ success: true, orders: [oldOrder], customer });
    await initializeAccountPage();
    expect(element("profileSummary").textContent).toBe("Add a delivery address for faster checkout");
    expect(element("profileToggle").textContent).toBe("Add address");
    expect(field("fieldAddress").value).toBe("");
    expect(field("fieldCity").value).toBe("");
    expect(field("fieldName").value).toBe(customer.name);
    expect(element("orderCount").textContent).toBe("1 order");
  });

  it("never saves a blank name and says so under the field", async () => {
    await initializeAccountPage();
    element("profileToggle").click();
    field("fieldName").value = "  ";
    field("fieldName").dispatchEvent(new Event("blur"));
    expect(element("fieldNameError").textContent).toBe("Enter your full name.");
    expect(field("fieldName").getAttribute("aria-invalid")).toBe("true");
    save();
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("fieldName"));
    field("fieldName").value = "Fixed name";
    field("fieldName").dispatchEvent(new Event("input"));
    expect(element("fieldNameError").classList.contains("hidden")).toBe(true);
  });

  it("validates a partial or short address like checkout", async () => {
    await initializeAccountPage();
    change("fieldCity", "");
    save();
    expect(element("fieldCityError").textContent).toBe("Choose a city.");
    field("fieldAddress").value = "House 1";
    change("fieldCity", customer.city!);
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    save();
    expect(element("fieldAddressError").textContent).toBe("Enter a complete delivery address (at least 10 characters).");
    expect(element("fieldZoneError").textContent).toBe("Choose a thana to continue.");
    expect(updateCustomerProfile).not.toHaveBeenCalled();
  });

  it("never reports Address saved for an empty address: it asks for each missing field", async () => {
    getCustomerSession.mockResolvedValue({
      authenticated: true, customer: { ...customer, address: null, city: null, cityName: null, zone: null, zoneName: null, area: null, areaName: null },
    });
    await initializeAccountPage();
    element("profileToggle").click();
    save();
    expect(element("fieldAddressError").textContent).toBe("Enter your delivery address.");
    expect(element("fieldCityError").textContent).toBe("Choose a city.");
    expect(field("fieldAddress").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field("fieldAddress"));
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    expect(element("profileSaved").classList.contains("hidden")).toBe(true);
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
  });

  it("updates the summary from the saved profile", async () => {
    const saved = { ...customer, name: "New name", address: "Road 7, House 12" };
    updateCustomerProfile.mockResolvedValue({ success: true, customer: saved });
    await initializeAccountPage();
    element("profileToggle").click();
    field("fieldName").value = "New name";
    field("fieldAddress").value = "Road 7, House 12";
    save();
    await vi.waitFor(() => expect(element("profileSaved").classList.contains("hidden")).toBe(false));
    expect(element("profileName").textContent).toBe("New name");
    expect(element("profileSummary").textContent).toContain("Road 7, House 12");
    expect(element("profileToggle").textContent).toBe("Edit");
  });

  it("keeps the buyer's input and shows the offline message when the save cannot reach the store", async () => {
    updateCustomerProfile.mockResolvedValue({ success: false, unavailable: true, status: 502, error: "Proxy error" });
    await initializeAccountPage();
    element("profileToggle").click();
    field("fieldName").value = "Draft name";
    save();
    await vi.waitFor(() => expect(element("profileSaveStatus").textContent).toBe("We couldn't reach the store. Check your connection and try again."));
    expect(field("fieldName").value).toBe("Draft name");
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
  });

  it("makes the saved profile editable while orders are pending", async () => {
    const orders = deferred<OrdersResult>();
    getCustomerOrders.mockReturnValueOnce(orders.promise);
    const initialization = initializeAccountPage();
    await vi.waitFor(() => expect(field("fieldZone").value).toBe(customer.zone));
    element("profileToggle").click();
    expect(field("fieldName").value).toBe(customer.name);
    expect(field("fieldAddress").value).toBe(customer.address);
    orders.resolve(ordersFailure);
    await initialization;
    field("fieldName").value = "Updated name";
    save();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: "Updated name", address: customer.address, city: customer.city, zone: customer.zone, area: customer.area,
    }));
  });

  it("keeps Save unavailable until initial location values are bound", async () => {
    const locations = deferred<typeof zones>();
    getZones.mockReturnValueOnce(locations.promise);
    const initialization = initializeAccountPage();
    await vi.waitFor(() => expect(getZones).toHaveBeenCalledOnce());
    expect(saveButton().disabled).toBe(true);
    save();
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    locations.resolve(zones);
    await initialization;
    expect(field("fieldZone").value).toBe(customer.zone);
    expect(saveButton().disabled).toBe(false);
  });

  it("preserves the saved area through its initial read and an unrelated address save", async () => {
    const locations = deferred<typeof areas>();
    getAreas.mockReturnValueOnce(locations.promise);
    const initialization = initializeAccountPage();
    await vi.waitFor(() => expect(getAreas).toHaveBeenCalledWith(customer.zone));
    expect(saveButton().disabled).toBe(true);
    locations.resolve(areas);
    await initialization;
    expect(field("fieldArea").value).toBe(customer.area);
    expect(element("profileAreaField").hidden).toBe(false);
    field("fieldAddress").value = "New street address";
    save();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: "New street address", city: customer.city, zone: customer.zone, area: customer.area,
    }));
  });

  it("clears descendants immediately and persists a new city, zone and optional area", async () => {
    getCities.mockResolvedValue([...cities, { id: "city_bagerhat", name: "Bagerhat" }]);
    await initializeAccountPage();
    const nextZones = deferred<typeof zones>();
    getZones.mockReturnValueOnce(nextZones.promise);
    change("fieldCity", "city_bagerhat");
    expect(field("fieldZone").value).toBe("");
    expect(field("fieldArea").value).toBe("");
    expect(saveButton().disabled).toBe(true);
    nextZones.resolve([{ id: "zone_sadar", name: "Bagerhat Sadar" }]);
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    save();
    expect(element("fieldZoneError").textContent).toBe("Choose a thana to continue.");
    const nextAreas = deferred<typeof areas>();
    getAreas.mockReturnValueOnce(nextAreas.promise);
    change("fieldZone", "zone_sadar");
    expect(element("fieldZoneError").classList.contains("hidden")).toBe(true);
    expect(saveButton().disabled).toBe(true);
    nextAreas.resolve([{ id: "area_school", name: "Adarsh school" }]);
    await vi.waitFor(() => expect(field("fieldArea").disabled).toBe(false));
    save();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, city: "city_bagerhat", zone: "zone_sadar", area: "",
    }));
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    change("fieldArea", "area_school");
    save();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, city: "city_bagerhat", zone: "zone_sadar", area: "area_school",
    }));
  });

  it("submits an empty area when changing only the zone", async () => {
    getZones.mockResolvedValue([...zones, { id: "zone_central", name: "Central Road" }]);
    await initializeAccountPage();
    getAreas.mockResolvedValueOnce([]);
    change("fieldZone", "zone_central");
    expect(field("fieldArea").value).toBe("");
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    save();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, city: customer.city, zone: "zone_central", area: "",
    }));
  });

  it.each(["cities", "zones", "areas"])("retries failed initial %s reads without erasing text edits", async (failure) => {
    if (failure === "cities") getCities.mockResolvedValueOnce(null);
    if (failure === "zones") getZones.mockResolvedValueOnce(null);
    if (failure === "areas") getAreas.mockResolvedValueOnce(null);
    await initializeAccountPage();
    element("profileToggle").click();
    expect(saveButton().disabled).toBe(true);
    expect(element("profileSaveStatus").textContent).toContain("Try again before saving");
    expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(false);
    field("fieldName").value = "Unsaved name";
    element("profileLocationsRetryBtn").click();
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(field("fieldName").value).toBe("Unsaved name");
    expect(field("fieldArea").value).toBe(customer.area);
    expect(getCities).toHaveBeenCalledTimes(failure === "cities" ? 2 : 1);
    expect(getZones).toHaveBeenCalledTimes(failure === "zones" ? 2 : 1);
    expect(getAreas).toHaveBeenCalledTimes(failure === "areas" ? 2 : 1);
    expect(getCustomerOrders).toHaveBeenCalledTimes(1);
  });

  it.each(["zones", "areas"])("retries a failed edited %s selection without restoring the old profile", async (failure) => {
    getCities.mockResolvedValue([...cities, { id: "city_other", name: "Other city" }]);
    getZones.mockResolvedValue([...zones, { id: "zone_other", name: "Other zone" }]);
    await initializeAccountPage();
    field("fieldName").value = "Edited name";
    if (failure === "zones") {
      getZones.mockResolvedValueOnce(null);
      change("fieldCity", "city_other");
    } else {
      getAreas.mockResolvedValueOnce(null);
      change("fieldZone", "zone_other");
    }
    await vi.waitFor(() => expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(false));
    expect(saveButton().disabled).toBe(true);
    element("profileLocationsRetryBtn").click();
    await vi.waitFor(() => expect(field(failure === "zones" ? "fieldZone" : "fieldArea").disabled).toBe(false));
    expect(field("fieldCity").value).toBe(failure === "zones" ? "city_other" : customer.city);
    expect(field("fieldZone").value).toBe(failure === "zones" ? "" : "zone_other");
    expect(field("fieldName").value).toBe("Edited name");
    expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(true);
  });

  it.each(["city", "zone"])("requires an explicit replacement for an unavailable saved %s", async (missing) => {
    if (missing === "city") getCities.mockResolvedValue([{ id: "city_active", name: "Active city" }]);
    getZones.mockResolvedValue([{ id: "zone_active", name: "Active zone" }]);
    await initializeAccountPage();
    expect(field("fieldCity").value).toBe(customer.city);
    expect(field("fieldZone").value).toBe(customer.zone);
    expect(saveButton().disabled).toBe(true);
    expect(element("profileSaveStatus").textContent).toContain("no longer available");
    save();
    expect(updateCustomerProfile).not.toHaveBeenCalled();
    if (missing === "city") {
      change("fieldCity", "city_active");
      await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    }
    change("fieldZone", "zone_active");
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    save();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address,
      city: missing === "city" ? "city_active" : customer.city, zone: "zone_active", area: "",
    }));
  });

  it.each(["", "area_active"])("preserves an unavailable area until the buyer chooses %s", async (replacement) => {
    getAreas.mockResolvedValue([{ id: "area_active", name: "Active area" }]);
    await initializeAccountPage();
    expect(field("fieldArea").value).toBe(customer.area);
    expect(element("profileSaveStatus").textContent).toContain("no longer available");
    expect(saveButton().disabled).toBe(true);
    change("fieldArea", replacement);
    save();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: customer.name, address: customer.address, city: customer.city, zone: customer.zone, area: replacement,
    }));
  });

  it("explains an empty thana list", async () => {
    await initializeAccountPage();
    getZones.mockResolvedValueOnce([]);
    change("fieldCity");
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    expect(element("profileSaveStatus").textContent).toContain("No thanas are available");
    field("fieldAddress").value = "";
    change("fieldCity", "");
    expect(saveButton().disabled).toBe(false);
    expect(element("profileSaveStatus").classList.contains("hidden")).toBe(true);
  });

  it("keeps only the latest zones when rapid city changes return to the same city", async () => {
    getCities.mockResolvedValue([...cities, { id: "city_other", name: "Other city" }]);
    await initializeAccountPage();
    const reads = [deferred<typeof zones | null>(), deferred<typeof zones | null>(), deferred<typeof zones | null>()];
    reads.forEach((read) => getZones.mockReturnValueOnce(read.promise));
    for (const city of ["city_other", customer.city!, "city_other"]) change("fieldCity", city);
    reads[2]!.resolve([{ id: "zone_latest", name: "Latest zone" }]);
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
    change("fieldZone", "zone_latest");
    await vi.waitFor(() => expect(field("fieldArea").disabled).toBe(false));
    reads[0]!.resolve([{ id: "zone_old", name: "Old zone" }]);
    reads[1]!.resolve(null);
    await Promise.all(reads.map((read) => read.promise));
    expect(Array.from(element<HTMLSelectElement>("fieldZone").options, (option) => option.value)).toEqual(["", "zone_latest"]);
    expect(saveButton().disabled).toBe(false);
    expect(element("profileLocationsRetryBtn").classList.contains("hidden")).toBe(true);
  });

  it("keeps only the latest areas when rapid zone changes return to the same zone", async () => {
    getZones.mockResolvedValue([...zones, { id: "zone_other", name: "Other zone" }]);
    await initializeAccountPage();
    const reads = [deferred<typeof areas | null>(), deferred<typeof areas | null>(), deferred<typeof areas | null>()];
    reads.forEach((read) => getAreas.mockReturnValueOnce(read.promise));
    for (const zone of ["zone_other", customer.zone!, "zone_other"]) change("fieldZone", zone);
    reads[2]!.resolve([{ id: "area_latest", name: "Latest area" }]);
    await vi.waitFor(() => expect(field("fieldArea").disabled).toBe(false));
    change("fieldArea", "area_latest");
    reads[0]!.resolve(null);
    reads[1]!.resolve(areas);
    await Promise.all(reads.map((read) => read.promise));
    expect(Array.from(element<HTMLSelectElement>("fieldArea").options, (option) => option.value)).toEqual(["", "area_latest"]);
    expect(field("fieldArea").value).toBe("area_latest");
    expect(saveButton().disabled).toBe(false);
  });

  it("does not enable a second save when location controls change during a pending save", async () => {
    await initializeAccountPage();
    element("profileToggle").click();
    const pending = deferred<{ success: boolean }>();
    updateCustomerProfile.mockReturnValueOnce(pending.promise);
    save();
    change("fieldZone");
    expect(saveButton().disabled).toBe(true);
    save();
    expect(updateCustomerProfile).toHaveBeenCalledTimes(1);
    const locations = deferred<typeof zones>();
    getZones.mockReturnValueOnce(locations.promise);
    change("fieldCity");
    pending.resolve({ success: true });
    await vi.waitFor(() => expect(saveButton().textContent).toBe("Save address"));
    expect(element("profileSaveStatus").textContent).toContain("Loading delivery locations");
    expect(saveButton().disabled).toBe(true);
    expect(element("profileForm").classList.contains("hidden")).toBe(false);
    locations.resolve(zones);
    await vi.waitFor(() => expect(field("fieldZone").disabled).toBe(false));
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
    expect(field("fieldArea").disabled).toBe(true);
  });
});
