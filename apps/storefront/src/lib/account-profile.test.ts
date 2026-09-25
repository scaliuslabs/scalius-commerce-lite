// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerInfo, getCustomerOrders as readOrders } from "./api/customer-auth";
import type { AccountOrder } from "./account-page";

const api = vi.hoisted(() => ({
  getCustomerSession: vi.fn(),
  getCustomerOrders: vi.fn(),
  updateCustomerProfile: vi.fn(),
  logoutCustomer: vi.fn(),
  sendPhoneVerificationCode: vi.fn(),
  verifyPhone: vi.fn(),
  getCities: vi.fn(),
  getZones: vi.fn(),
  getAreas: vi.fn(),
}));
vi.mock("./api/customer-auth", () => ({
  getCustomerSession: api.getCustomerSession,
  getCustomerOrders: api.getCustomerOrders,
  updateCustomerProfile: api.updateCustomerProfile,
  logoutCustomer: api.logoutCustomer,
  sendPhoneVerificationCode: api.sendPhoneVerificationCode,
  verifyPhone: api.verifyPhone,
}));
vi.mock("./api/shipping", () => ({ getCities: api.getCities, getZones: api.getZones, getAreas: api.getAreas }));
vi.mock("./product-media", () => ({ getProductImageUrl: () => "/placeholder-product.svg" }));
const inbox = vi.hoisted(() => ({ unread: 0, reviewsToWrite: 0, giftCards: 0 }));
vi.mock("./account-tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./account-tabs")>()),
  fetchAccountSummary: async () => ({ unreadInbox: inbox.unread, reviewsToWrite: inbox.reviewsToWrite, downloads: 0, giftCards: inbox.giftCards, activeWarranties: 0 }),
}));

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

/** The location picker's value: the hidden select the combobox drives. */
function place(name: "city" | "zone" | "area") {
  return document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
}

/** Chooses like the combobox does: sets the select and fires `change`. */
function choose(name: "city" | "zone" | "area", value: string) {
  place(name).value = value;
  place(name).dispatchEvent(new Event("change", { bubbles: true }));
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
        <div data-location-fields data-loading-text="Loading…" data-no-match-text="No match for “{query}”" data-close-text="Close">
          <label for="profile-city">City</label>
          <select id="profile-city" name="city" aria-required="true"><option value="">Select a city</option></select>
          <label for="profile-zone">Thana</label>
          <select id="profile-zone" name="zone" aria-required="true" disabled><option value="">Select a thana</option></select>
          <button type="button" hidden data-location-retry="zone">Retry</button>
          <div data-location-area hidden>
            <label for="profile-area">Area</label>
            <select id="profile-area" name="area" disabled><option value="">Select an area (optional)</option></select>
            <button type="button" hidden data-location-retry="area">Retry</button>
          </div>
          <input type="hidden" name="cityName" /><input type="hidden" name="zoneName" /><input type="hidden" name="areaName" />
        </div>
        <p id="profileLocationError" class="hidden"></p>
        <p id="profileSaveStatus" class="hidden"></p>
        <button id="profileLocationsRetryBtn" type="button" class="hidden">Retry</button>
        <button id="saveProfileBtn" type="submit" disabled>Save address</button>
      </form>
      <h2 id="ordersHeading" tabindex="-1">Orders</h2><span id="orderCount"></span>
      <p id="phoneVerificationStatus" role="status"></p><div id="phoneVerification" class="hidden"></div>
      <p id="phoneVerificationContact" data-store-contact hidden>Contact the store: <a href="tel:+8801711000000">01711-000000</a></p>
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

  it("never mentions orders tied to a contact the buyer hasn't proven", async () => {
    getCustomerOrders.mockResolvedValue({
      success: true, orders: [], customer,
      unclaimedGuestOrders: [{ id: "cust_guest_1", destination: "01•••••002", orderCount: 1, canVerify: false }],
    } as unknown as OrdersResult);
    await initializeAccountPage();
    await vi.waitFor(() => expect(element("emptyOrders").classList.contains("hidden")).toBe(false));

    expect(element("phoneVerification").classList.contains("hidden")).toBe(true);
    expect(element("phoneVerification").textContent).toBe("");
    expect(document.body.textContent).not.toMatch(/01•••••002|placed with|contact the store to add/i);
  });

  it("offers to verify the account's own phone and reloads the orders once it is verified", async () => {
    getCustomerOrders
      .mockResolvedValueOnce({ success: true, orders: [], customer, phoneVerification: { phone: "+8801712345678" } })
      .mockResolvedValueOnce({ success: true, orders: [oldOrder], customer, phoneVerification: null });
    api.sendPhoneVerificationCode.mockResolvedValue({ success: true, message: "We sent a code to 01•••••678.", resendAfterSeconds: 60 });
    api.verifyPhone.mockResolvedValue({ success: true, movedOrders: 1, message: "Your phone number is verified. 1 order was added to your account." });
    await initializeAccountPage();

    const notice = element("phoneVerification");
    await vi.waitFor(() => expect(notice.classList.contains("hidden")).toBe(false));
    expect(notice.textContent).toContain("Verify your phone number 01712-345678 to add orders you placed with it.");
    [...notice.querySelectorAll("button")].find((button) => button.textContent === "Verify phone")!.click();
    await vi.waitFor(() => expect(notice.querySelector("form")?.classList.contains("hidden")).toBe(false));
    notice.querySelector<HTMLInputElement>("input[name=code]")!.value = "123456";
    notice.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));

    await vi.waitFor(() => expect(element("orderCount").textContent).toBe("1 order"));
    expect(api.verifyPhone).toHaveBeenCalledWith("123456");
    expect(getCustomerOrders).toHaveBeenCalledTimes(2);
    expect(notice.classList.contains("hidden")).toBe(true);
    expect(notice.textContent).toBe("");
    expect(element("phoneVerificationStatus").textContent).toBe("Your phone number is verified. 1 order was added to your account.");
    expect(document.activeElement).toBe(element("ordersHeading"));
    expect(getCustomerSession).toHaveBeenCalledTimes(1);
  });

  it("shows the store's contact next to the message when phone codes can't be sent", async () => {
    getCustomerOrders.mockResolvedValue({ success: true, orders: [], customer, phoneVerification: { phone: "+8801712345678" } });
    api.sendPhoneVerificationCode.mockResolvedValue({ success: false, status: 503, error: "Text message codes aren't available right now." });
    await initializeAccountPage();

    const notice = element("phoneVerification");
    await vi.waitFor(() => expect(notice.classList.contains("hidden")).toBe(false));
    [...notice.querySelectorAll("button")].find((button) => button.textContent === "Verify phone")!.click();

    await vi.waitFor(() => expect(notice.querySelector("[role=status]")?.textContent).toBe("Text message codes aren't available right now."));
    expect(notice.querySelector<HTMLElement>("[data-store-contact]")?.hidden).toBe(false);
    expect(notice.querySelector("a[href='tel:+8801711000000']")).not.toBeNull();
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

describe("account inbox tab", () => {
  it("links the Inbox with the unread count and hides the badge when nothing is new", async () => {
    inbox.unread = 3;
    await initializeAccountPage();
    await vi.waitFor(() => expect(element("accountInboxBadge").hidden).toBe(false));
    const link = document.querySelector<HTMLAnchorElement>('#accountTabs a[href="/account/inbox"]')!;
    expect(link.textContent).toContain("Inbox");
    expect(element("accountInboxBadge").textContent).toBe("3 unread");

    inbox.unread = 0;
    await initializeAccountPage();
    await vi.waitFor(() => expect(element("accountInboxBadge").hidden).toBe(true));
    expect(document.querySelectorAll("#accountTabs")).toHaveLength(1);
  });

  it("adds a feature tab only while its count is above zero", async () => {
    const tabs = () => [...document.querySelectorAll<HTMLAnchorElement>("#accountTabs a")].map((link) => link.getAttribute("href"));
    await initializeAccountPage();
    await vi.waitFor(() => expect(element("accountInboxBadge").hidden).toBe(true));
    expect(tabs()).toEqual(["/account", "/account/inbox"]);

    inbox.reviewsToWrite = 2;
    inbox.giftCards = 1;
    await initializeAccountPage();
    await vi.waitFor(() => expect(tabs()).toEqual(["/account", "/account/inbox", "/account/reviews", "/account/gift-cards"]));

    inbox.reviewsToWrite = 0;
    inbox.giftCards = 0;
    await initializeAccountPage();
    await vi.waitFor(() => expect(tabs()).toEqual(["/account", "/account/inbox"]));
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
    expect(place("city").value).toBe("");
    expect(field("fieldName").value).toBe(customer.name);
    expect(element("orderCount").textContent).toBe("1 order");
  });

  it("shows the saved city, thana and area in the same pickers as checkout", async () => {
    await initializeAccountPage();
    const city = element<HTMLInputElement>("profile-city");
    expect(city.getAttribute("role")).toBe("combobox");
    expect(document.querySelector('label[for="profile-city"]')).not.toBeNull();
    expect(city.value).toBe("Dhaka");
    expect(element<HTMLInputElement>("profile-zone").value).toBe("Mirpur");
    expect(element<HTMLInputElement>("profile-area").value).toBe("Mirpur 1");
    expect(saveButton().disabled).toBe(false);
    expect(element("profileSaveStatus").textContent).toBe("");
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

  it("validates a partial or short address like checkout, at the location still to choose", async () => {
    await initializeAccountPage();
    choose("city", "");
    save();
    expect(element("profileLocationError").textContent).toBe("Choose a city and thana to continue.");
    expect(element("profile-city").getAttribute("aria-invalid")).toBe("true");
    field("fieldAddress").value = "House 1";
    choose("city", customer.city!);
    await vi.waitFor(() => expect(place("zone").disabled).toBe(false));
    save();
    expect(element("fieldAddressError").textContent).toBe("Enter a complete delivery address (at least 10 characters).");
    expect(element("profileLocationError").textContent).toBe("Choose a thana to continue.");
    expect(element("profile-zone").getAttribute("aria-invalid")).toBe("true");
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
    expect(element("profileLocationError").textContent).toBe("Choose a city and thana to continue.");
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
    await vi.waitFor(() => expect(place("area").value).toBe(customer.area));
    field("fieldName").value = "New name";
    field("fieldAddress").value = "Road 7, House 12";
    save();
    await vi.waitFor(() => expect(element("profileSaved").classList.contains("hidden")).toBe(false));
    expect(updateCustomerProfile).toHaveBeenCalledWith({
      name: "New name", address: "Road 7, House 12", city: customer.city, zone: customer.zone, area: customer.area,
    });
    expect(element("profileName").textContent).toBe("New name");
    expect(element("profileSummary").textContent).toContain("Road 7, House 12");
    expect(element("profileToggle").textContent).toBe("Edit");
  });

  it("clears the thana and area when the city changes and saves the new choice", async () => {
    getCities.mockResolvedValue([...cities, { id: "city_ctg", name: "Chattogram" }]);
    getZones.mockImplementation(async (cityId: string) =>
      cityId === "city_ctg" ? [{ id: "zone_agrabad", name: "Agrabad" }] : zones);
    getAreas.mockImplementation(async (zoneId: string) => (zoneId === "zone_agrabad" ? [] : areas));
    await initializeAccountPage();
    element("profileToggle").click();
    await vi.waitFor(() => expect(place("area").value).toBe(customer.area));
    choose("city", "city_ctg");
    expect(place("zone").value).toBe("");
    expect(place("area").value).toBe("");
    expect(element<HTMLInputElement>("profile-zone").value).toBe("");
    expect(document.activeElement).toBe(element("profile-zone"));
    await vi.waitFor(() => expect(place("zone").disabled).toBe(false));
    choose("zone", "zone_agrabad");
    save();
    await vi.waitFor(() => expect(updateCustomerProfile).toHaveBeenCalled());
    expect(updateCustomerProfile.mock.calls[0]![0]).toMatchObject({ city: "city_ctg", zone: "zone_agrabad", area: "" });
  });

  it("asks for a new choice when the saved thana is no longer offered", async () => {
    getZones.mockResolvedValue([{ id: "zone_other", name: "Other" }]);
    await initializeAccountPage();
    expect(place("city").value).toBe(customer.city);
    expect(place("zone").value).toBe("");
    expect(element("profileSaveStatus").textContent).toBe("Your saved delivery location is no longer available. Choose it again.");
    element("profileToggle").click();
    await vi.waitFor(() => expect(place("zone").disabled).toBe(false));
    save();
    expect(element("profileLocationError").textContent).toBe("Choose a thana to continue.");
    expect(updateCustomerProfile).not.toHaveBeenCalled();
  });

  it("retries a failed cities read without erasing text edits", async () => {
    getCities.mockResolvedValueOnce(null);
    await initializeAccountPage();
    expect(element("profileSaveStatus").textContent).toBe("Your delivery locations could not be loaded. Try again before saving.");
    expect(saveButton().disabled).toBe(true);
    field("fieldAddress").value = "Edited delivery address";
    element("profileLocationsRetryBtn").click();
    await vi.waitFor(() => expect(place("zone").value).toBe(customer.zone));
    expect(field("fieldAddress").value).toBe("Edited delivery address");
    expect(saveButton().disabled).toBe(false);
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
});
