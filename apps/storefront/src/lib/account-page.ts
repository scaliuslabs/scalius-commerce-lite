// The /account page: profile, delivery details and order history.

import {
  getCustomerOrders,
  getCustomerSession,
  logoutCustomer,
  updateCustomerProfile,
  type CustomerInfo,
  type CustomerOrder,
} from "@/lib/api/customer-auth";
import { getAreas, getCities, getZones } from "@/lib/api/shipping";
import { renderPhoneVerification } from "@/lib/account-phone-verification";
import { getShippingAddressError } from "@/lib/checkout/shipping-address";
import { getProductImageUrl } from "@/lib/product-media";
import { escapeHtml } from "@scalius/shared/html-escape";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA as copy } from "@scalius/shared/checkout-language";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatBdMobile } from "@scalius/shared/phone-input";
import {
  ACCOUNT_OFFLINE_MESSAGE,
  accountMoney,
  formatAccountDate,
  formatDeliveryArea,
  openRequestLabel,
  orderPaymentLine,
} from "@/lib/account-format";
import { CONVERSATION_COPY, inboxBadgeText } from "@/lib/account-inbox";
import { fetchAccountSummary, visibleAccountFeatureTabs } from "@/lib/account-tabs";

/** Fields the account list reads beyond the generated order type. */
export type AccountOrder = CustomerOrder;

type AccountWindow = Window & { __scaliusAccountInitRun?: number };
const accountWindow = window as AccountWindow;
const ORDERS_PER_PAGE = 5;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function orderStatusTone(status: string): string {
  if (status === "cancelled") return "bg-destructive/10 text-destructive";
  if (status === "delivered" || status === "completed") return "bg-primary/10 text-primary";
  return "bg-muted text-foreground";
}

function renderOrder(order: AccountOrder): string {
  const detailHref = `/account/orders/${encodeURIComponent(order.id)}`;
  const detailsId = `order-details-${order.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const openRequest = openRequestLabel(order.openSupportRequestType);
  const shipment = order.latestShipment;
  const courier = shipment ? shipment.providerName || shipment.courierName : null;
  const delivered = order.status === "delivered" || order.status === "completed";
  const place = formatDeliveryArea(order);
  const items = order.items.map((item) => `
    <li class="flex items-start gap-3 py-3">
      <img src="${escapeHtml(getProductImageUrl(item.productImage, 96))}" alt="" class="h-12 w-12 shrink-0 rounded-md border border-border bg-card object-contain" loading="lazy" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-foreground">${escapeHtml(item.productName || "Product")}</p>
        ${item.variantLabel ? `<p class="text-sm text-muted-foreground">${escapeHtml(item.variantLabel)}</p>` : ""}
      </div>
      <p class="shrink-0 text-sm tabular-nums text-foreground">${item.quantity} × ${accountMoney(item.price, order.currencyCode)}</p>
    </li>`).join("");
  const row = (label: string, value: string, strong = false) =>
    `<div class="flex justify-between gap-4 ${strong ? "font-medium text-foreground" : "text-muted-foreground"}"><span>${label}</span><span class="tabular-nums">${value}</span></div>`;
  const payment = orderPaymentLine(order);

  return `
    <article class="order-card relative rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40 sm:p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="break-all text-base font-semibold text-foreground">
            <a href="${escapeHtml(detailHref)}" data-astro-prefetch="false" class="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">Order ${escapeHtml(formatOrderNumber(order.orderNumber, order.id))}</a>
          </h3>
          <p class="mt-1 text-sm text-muted-foreground">${escapeHtml(formatAccountDate(order.createdAt, { time: false }))} · ${itemCount} item${itemCount === 1 ? "" : "s"}</p>
        </div>
        <p class="shrink-0 text-base font-semibold tabular-nums text-foreground">${accountMoney(order.totalAmount, order.currencyCode)}</p>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span class="rounded-md px-2 py-0.5 font-medium ${orderStatusTone(order.status)}">${escapeHtml(order.statusLabel ?? order.status)}</span>
        ${openRequest ? `<span class="rounded-md bg-amber-500/10 px-2 py-0.5 font-medium text-amber-800 dark:text-amber-300">${escapeHtml(openRequest)}</span>` : ""}
      </div>
      <p class="mt-2 text-sm text-muted-foreground">${escapeHtml(`${payment.method} · ${payment.state}`)}</p>
      ${shipment ? `<p class="mt-1 text-sm text-muted-foreground">${escapeHtml([courier, shipment.statusLabel].filter(Boolean).join(" · "))}</p>` : ""}
      <button type="button" class="relative z-10 mt-2 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline" data-order-toggle="${escapeHtml(detailsId)}" aria-expanded="false" aria-controls="${escapeHtml(detailsId)}">Quick view</button>
      <div id="${escapeHtml(detailsId)}" class="order-details relative z-10 hidden border-t border-border pt-2">
        <ul class="divide-y divide-border">${items}</ul>
        <div class="mt-2 space-y-1 border-t border-border pt-3 text-sm">
          ${order.shippingCharge > 0 ? row("Delivery", accountMoney(order.shippingCharge, order.currencyCode)) : ""}
          ${(order.discountAmount ?? 0) > 0 ? row("Discount", `-${accountMoney(order.discountAmount ?? 0, order.currencyCode)}`) : ""}
          ${row("Total", accountMoney(order.totalAmount, order.currencyCode), true)}
          ${order.paidAmount > 0 ? row("Paid", accountMoney(order.paidAmount, order.currencyCode)) : ""}
          ${payment.balanceDue > 0 ? row(escapeHtml(payment.balanceLabel), accountMoney(payment.balanceDue, order.currencyCode), true) : ""}
        </div>
        ${order.shippingAddress ? `<p class="mt-3 text-sm text-muted-foreground"><span class="font-medium text-foreground">${delivered ? "Delivered to" : "Delivering to"}:</span> ${escapeHtml([order.shippingAddress, place].filter(Boolean).join(", "))}</p>` : ""}
      </div>
    </article>`;
}

function bindOrderDetailToggles(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>("[data-order-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const details = document.getElementById(button.dataset.orderToggle ?? "");
      if (!details) return;
      const expanded = !details.classList.toggle("hidden");
      button.setAttribute("aria-expanded", String(expanded));
      button.textContent = expanded ? "Hide details" : "Quick view";
    });
  });
}

async function loadAccountOrders(runId: number): Promise<void> {
  const ordersList = byId("ordersList");
  const emptyOrders = byId("emptyOrders");
  const ordersError = byId("ordersError");
  const orderCount = byId("orderCount");
  const showMoreContainer = byId("showMoreContainer");
  const showMoreBtn = byId<HTMLButtonElement>("showMoreBtn");
  const ordersRetryBtn = byId<HTMLButtonElement>("ordersRetryBtn");
  const phoneNotice = document.getElementById("phoneVerification");
  ordersRetryBtn.disabled = true;
  ordersRetryBtn.onclick = () => void loadAccountOrders(runId);
  if (phoneNotice) renderPhoneVerification(phoneNotice, null, { onVerified: () => undefined });
  ordersList.innerHTML = "";
  emptyOrders.classList.add("hidden");
  ordersError.classList.add("hidden");
  showMoreContainer.classList.add("hidden");
  orderCount.textContent = "";

  const result = await getCustomerOrders();
  if (accountWindow.__scaliusAccountInitRun !== runId) return;
  ordersRetryBtn.disabled = false;

  if (!result.success) {
    const sessionExpired = result.status === 401;
    byId("ordersErrorMessage").textContent = sessionExpired
      ? "Your session expired. Sign in again to see your orders."
      : result.unavailable ? ACCOUNT_OFFLINE_MESSAGE : result.error || ACCOUNT_OFFLINE_MESSAGE;
    ordersError.classList.remove("hidden");
    return;
  }

  // The account's own phone isn't verified and the store can text it a code.
  if (phoneNotice) {
    renderPhoneVerification(phoneNotice, result.phoneVerification, {
      storeContact: document.getElementById("phoneVerificationContact"),
      onVerified: async (message) => {
        const status = document.getElementById("phoneVerificationStatus");
        if (status) status.textContent = message;
        await loadAccountOrders(runId);
        if (accountWindow.__scaliusAccountInitRun === runId) document.getElementById("ordersHeading")?.focus();
      },
    });
  }

  const totalOrders = result.summary?.totalOrders ?? result.orders.length;
  let loaded = result.orders as AccountOrder[];
  let nextCursor = result.pagination?.nextCursor ?? null;
  let visible = Math.min(ORDERS_PER_PAGE, loaded.length);
  let loadingMore = false;

  const render = () => {
    orderCount.textContent = nextCursor
      ? `${loaded.length} of ${totalOrders} orders`
      : `${loaded.length} order${loaded.length === 1 ? "" : "s"}`;
    ordersList.innerHTML = loaded.slice(0, visible).map(renderOrder).join("");
    bindOrderDetailToggles(ordersList);
    showMoreContainer.classList.toggle("hidden", visible >= loaded.length && !nextCursor);
  };

  if (loaded.length === 0) {
    emptyOrders.classList.remove("hidden");
    return;
  }
  render();

  showMoreBtn.onclick = async () => {
    if (visible < loaded.length) {
      visible = Math.min(visible + ORDERS_PER_PAGE, loaded.length);
      render();
      return;
    }
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    showMoreBtn.disabled = true;
    showMoreBtn.textContent = "Loading…";
    const nextPage = await getCustomerOrders({ cursor: nextCursor });
    if (accountWindow.__scaliusAccountInitRun !== runId) return;
    loadingMore = false;
    showMoreBtn.disabled = false;
    showMoreBtn.textContent = "Show more orders";
    if (!nextPage.success) {
      byId("showMoreError").textContent = ACCOUNT_OFFLINE_MESSAGE;
      return;
    }
    byId("showMoreError").textContent = "";
    const known = new Set(loaded.map((order) => order.id));
    loaded = [...loaded, ...(nextPage.orders as AccountOrder[]).filter((order) => !known.has(order.id))];
    nextCursor = nextPage.pagination?.nextCursor ?? null;
    visible = Math.min(visible + ORDERS_PER_PAGE, loaded.length);
    render();
  };
}

function showFieldError(field: HTMLInputElement | HTMLSelectElement, message: string | null): void {
  const error = byId(`${field.id}Error`);
  error.textContent = message ?? "";
  error.classList.toggle("hidden", !message);
  field.setAttribute("aria-invalid", String(Boolean(message)));
}

/** Profile → Edit changes the account name only; email and phone stay as verified. */
function bindProfileNameEditor(
  runId: number,
  current: () => CustomerInfo,
  onSaved: (customer: CustomerInfo) => void,
): void {
  const form = byId<HTMLFormElement>("nameForm");
  const toggle = byId<HTMLButtonElement>("nameToggle");
  const input = byId<HTMLInputElement>("fieldProfileName");
  const saveBtn = byId<HTMLButtonElement>("saveNameBtn");
  const status = byId("nameSaveStatus");
  const saved = byId("nameSaved");
  const check = () => (input.value.trim() ? null : "Enter your full name.");
  const setEditing = (editing: boolean) => {
    form.classList.toggle("hidden", !editing);
    toggle.setAttribute("aria-expanded", String(editing));
    toggle.textContent = editing ? "Cancel" : "Edit";
    if (!editing) return;
    saved.classList.add("hidden");
    status.textContent = "";
    input.value = current().name ?? "";
    showFieldError(input, null);
    input.focus();
  };
  setEditing(false);
  toggle.onclick = () => setEditing(form.classList.contains("hidden"));
  input.onblur = () => showFieldError(input, check());
  input.oninput = () => { if (input.getAttribute("aria-invalid") === "true") showFieldError(input, check()); };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (saveBtn.disabled) return;
    const invalid = check();
    showFieldError(input, invalid);
    if (invalid) return input.focus();
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    status.textContent = "";
    const name = input.value.trim();
    const res = await updateCustomerProfile({ name });
    if (accountWindow.__scaliusAccountInitRun !== runId) return;
    saveBtn.disabled = false;
    saveBtn.textContent = "Save name";
    if (!res.success) {
      status.textContent = res.unavailable ? ACCOUNT_OFFLINE_MESSAGE : res.error || ACCOUNT_OFFLINE_MESSAGE;
      return;
    }
    onSaved(res.customer ?? { ...current(), name });
    setEditing(false);
    saved.classList.remove("hidden");
  };
}

function hasSavedAddress(customer: CustomerInfo): boolean {
  return Boolean(customer.address?.trim() && customer.city && customer.zone);
}

function renderProfile(customer: CustomerInfo): void {
  byId("profileName").textContent = customer.name;
  byId("profileEmail").textContent = customer.email ?? "";
  byId("profilePhone").textContent = customer.phone ? formatBdMobile(customer.phone) : "";
  const summary = byId("profileSummary");
  if (hasSavedAddress(customer)) {
    summary.innerHTML = [customer.name, customer.address, formatDeliveryArea(customer)]
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(String(line))}</p>`)
      .join("");
  } else {
    summary.innerHTML = `<p>Add a delivery address for faster checkout</p>`;
  }
}

/**
 * The account tabs (this page, the Inbox, then any Reviews, Downloads, Gift
 * cards or Warranties tab with something in it) with the unread-replies badge.
 */
function renderAccountTabs(runId: number): void {
  const tab = "inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium";
  if (!document.getElementById("accountTabs")) {
    const nav = document.createElement("nav");
    nav.id = "accountTabs";
    nav.setAttribute("aria-label", "Account");
    nav.className = "mb-6 flex gap-1 border-b border-border";
    nav.innerHTML = `
      <a href="/account" aria-current="page" data-astro-prefetch="false" class="${tab} border-primary text-foreground">${escapeHtml(CONVERSATION_COPY.accountTab)}</a>
      <a href="/account/inbox" data-astro-prefetch="false" class="${tab} gap-2 border-transparent text-muted-foreground hover:text-foreground">${escapeHtml(CONVERSATION_COPY.inboxTitle)}<span id="accountInboxBadge" hidden class="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold tabular-nums text-primary-foreground"></span></a>`;
    byId("authState").prepend(nav);
  }
  void fetchAccountSummary().then((summary) => {
    const badge = document.getElementById("accountInboxBadge");
    if (!badge || accountWindow.__scaliusAccountInitRun !== runId) return;
    const text = inboxBadgeText(summary?.unreadInbox ?? 0);
    badge.innerHTML = text ? `${escapeHtml(text)}<span class="sr-only"> unread</span>` : "";
    badge.hidden = !text;
    const nav = document.getElementById("accountTabs");
    nav?.querySelectorAll("[data-account-feature-tab]").forEach((link) => link.remove());
    nav?.insertAdjacentHTML("beforeend", visibleAccountFeatureTabs(summary).map((feature) =>
      `<a href="${escapeHtml(feature.href)}" data-astro-prefetch="false" data-account-feature-tab class="${tab} border-transparent text-muted-foreground hover:text-foreground">${escapeHtml(feature.label)}</a>`,
    ).join(""));
  });
}

export async function initializeAccountPage(): Promise<void> {
  if (!document.querySelector("[data-account-page]")) return;

  const runId = (accountWindow.__scaliusAccountInitRun ?? 0) + 1;
  accountWindow.__scaliusAccountInitRun = runId;

  const loadingState = byId("loadingState");
  const unauthState = byId("unauthState");
  const accountError = byId("accountError");
  const authState = byId("authState");
  byId("accountRetryBtn").onclick = () => void initializeAccountPage();

  loadingState.classList.remove("hidden");
  unauthState.classList.add("hidden");
  accountError.classList.add("hidden");
  authState.classList.add("hidden");

  const session = await getCustomerSession();
  if (accountWindow.__scaliusAccountInitRun !== runId) return;

  if (session.unavailable) {
    loadingState.classList.add("hidden");
    accountError.classList.remove("hidden");
    return;
  }

  if (!session.authenticated || !session.customer) {
    loadingState.classList.add("hidden");
    unauthState.classList.remove("hidden");
    return;
  }

  let customer = session.customer;
  renderProfile(customer);
  const phoneVerificationStatus = document.getElementById("phoneVerificationStatus");
  if (phoneVerificationStatus) phoneVerificationStatus.textContent = "";
  loadingState.classList.add("hidden");
  authState.classList.remove("hidden");
  renderAccountTabs(runId);

  const ordersRead = loadAccountOrders(runId);

  const form = byId<HTMLFormElement>("profileForm");
  const toggle = byId<HTMLButtonElement>("profileToggle");
  const saved = byId("profileSaved");
  const fName = byId<HTMLInputElement>("fieldName");
  const fAddress = byId<HTMLInputElement>("fieldAddress");
  const fCity = byId<HTMLSelectElement>("fieldCity");
  const fZone = byId<HTMLSelectElement>("fieldZone");
  const fArea = byId<HTMLSelectElement>("fieldArea");
  const areaField = byId("profileAreaField");
  const saveBtn = byId<HTMLButtonElement>("saveProfileBtn");
  const retryBtn = byId<HTMLButtonElement>("profileLocationsRetryBtn");
  const status = byId("profileSaveStatus");
  let isSaving = false;
  let zoneRead = 0;
  let areaRead = 0;

  // The same checks as checkout: nothing saves without a full address.
  const errors: Array<[HTMLInputElement | HTMLSelectElement, () => string | null]> = [
    [fName, () => fName.value.trim() ? null : "Enter your full name."],
    [fAddress, () => getShippingAddressError(fAddress.value)],
    [fCity, () => fCity.value ? null : "Choose a city."],
    [fZone, () => fCity.value && !fZone.value ? copy.zoneRequiredText : null],
  ];
  function validate(show: "all" | "shown"): boolean {
    let firstInvalid: HTMLInputElement | HTMLSelectElement | null = null;
    for (const [field, check] of errors) {
      const message = check();
      if (message && !firstInvalid) firstInvalid = field;
      if (show === "all" || field.getAttribute("aria-invalid") === "true") showFieldError(field, message);
    }
    if (show === "all") firstInvalid?.focus();
    return firstInvalid === null;
  }
  for (const [field, check] of errors) {
    field.onblur = () => showFieldError(field, check());
    field.oninput = () => { if (field.getAttribute("aria-invalid") === "true") validate("shown"); };
  }

  function hasUnavailableLocation(): boolean {
    return [fCity, fZone, fArea].some((field) => field.options[field.selectedIndex]?.disabled);
  }

  function updateSaveAvailability(): void {
    areaField.hidden = !fArea.value && !Array.from(fArea.options).some((option) => option.value && !option.disabled);
    saveBtn.disabled = isSaving || fCity.disabled
      || Boolean(fCity.value && fZone.disabled)
      || Boolean(fZone.value && fArea.disabled) || hasUnavailableLocation();
  }

  function setStatus(message: string, tone: "muted" | "error" = "error"): void {
    status.textContent = message;
    status.className = `text-sm ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`;
    status.classList.toggle("hidden", !message);
  }

  function setLocationOptions(field: HTMLSelectElement, options: { id: string; name: string }[], placeholder: string, savedId = "", savedName?: string | null): boolean {
    const option = (value: string, text: string) => {
      const element = document.createElement("option");
      element.value = value;
      element.textContent = text;
      return element;
    };
    field.replaceChildren(...[{ id: "", name: placeholder }, ...options].map((location) => option(location.id, location.name)));
    const available = !savedId || options.some((location) => location.id === savedId);
    if (!available) {
      const unavailable = option(savedId, `${savedName || "Saved location"} (unavailable)`);
      unavailable.disabled = true;
      field.add(unavailable);
    }
    field.value = savedId;
    return available;
  }

  function updateLocationReadiness(): void {
    updateSaveAvailability();
    setStatus(hasUnavailableLocation()
      ? "Your saved delivery location is no longer available. Choose an available location or clear it before saving."
      : fCity.value && !fZone.value && fZone.options.length <= 1
        ? "No thanas are available for this city. Choose another city."
        : "");
  }

  function showLocationLoading(): void {
    updateSaveAvailability();
    retryBtn.classList.add("hidden");
    retryBtn.onclick = null;
    setStatus("Loading delivery locations…", "muted");
  }

  function showLocationFailure(retry: () => Promise<void>): void {
    setStatus("Your delivery locations could not be loaded. Try again before saving.");
    retryBtn.onclick = () => void retry();
    retryBtn.classList.remove("hidden");
  }

  async function loadAreas(savedArea = "", areaName?: string | null): Promise<void> {
    const request = ++areaRead;
    const zoneId = fZone.value;
    setLocationOptions(fArea, [], "Select an area (optional)");
    fArea.disabled = true;
    showLocationLoading();
    if (!zoneId) return updateLocationReadiness();
    const areas = await getAreas(zoneId);
    if (accountWindow.__scaliusAccountInitRun !== runId || request !== areaRead) return;
    if (!areas) return showLocationFailure(() => loadAreas(savedArea, areaName));
    setLocationOptions(fArea, areas, "Select an area (optional)", savedArea, areaName);
    fArea.disabled = false;
    updateLocationReadiness();
  }

  async function loadZones(savedZone = "", zoneName?: string | null, savedArea = "", areaName?: string | null): Promise<void> {
    const request = ++zoneRead;
    ++areaRead;
    const cityId = fCity.value;
    setLocationOptions(fZone, [], copy.selectZonePlaceholder);
    setLocationOptions(fArea, [], "Select an area (optional)");
    fZone.disabled = true;
    fArea.disabled = true;
    showLocationLoading();
    if (!cityId) return updateLocationReadiness();
    const zones = await getZones(cityId);
    if (accountWindow.__scaliusAccountInitRun !== runId || request !== zoneRead) return;
    if (!zones) return showLocationFailure(() => loadZones(savedZone, zoneName, savedArea, areaName));
    const zoneAvailable = setLocationOptions(fZone, zones, copy.selectZonePlaceholder, savedZone, zoneName);
    fZone.disabled = false;
    if (savedZone && zoneAvailable) return loadAreas(savedArea, areaName);
    setLocationOptions(fArea, [], "Select an area (optional)", savedArea, areaName);
    updateLocationReadiness();
  }

  async function loadLocations(): Promise<void> {
    fCity.disabled = true;
    fZone.disabled = true;
    fArea.disabled = true;
    showLocationLoading();
    const cities = await getCities();
    if (accountWindow.__scaliusAccountInitRun !== runId) return;
    if (!cities) return showLocationFailure(loadLocations);
    const cityAvailable = setLocationOptions(fCity, cities, "Select a city", customer.city ?? "", customer.cityName);
    fCity.disabled = false;
    if (customer.city && cityAvailable) {
      return loadZones(customer.zone ?? "", customer.zoneName, customer.area ?? "", customer.areaName);
    }
    setLocationOptions(fZone, [], copy.selectZonePlaceholder, customer.zone ?? "", customer.zoneName);
    setLocationOptions(fArea, [], "Select an area (optional)", customer.area ?? "", customer.areaName);
    updateLocationReadiness();
  }

  function resetForm(): Promise<void> {
    fName.value = customer.name ?? "";
    fAddress.value = customer.address ?? "";
    for (const [field] of errors) showFieldError(field, null);
    return loadLocations();
  }

  function setEditing(editing: boolean): void {
    form.classList.toggle("hidden", !editing);
    toggle.setAttribute("aria-expanded", String(editing));
    toggle.textContent = editing ? "Cancel" : hasSavedAddress(customer) ? "Edit" : "Add address";
    if (editing) saved.classList.add("hidden");
  }

  fCity.onchange = () => { void loadZones(); validate("shown"); };
  fZone.onchange = () => { void loadAreas(); validate("shown"); };
  fArea.onchange = updateLocationReadiness;
  setEditing(false);
  toggle.onclick = () => {
    const editing = form.classList.contains("hidden");
    if (!editing) void resetForm();
    setEditing(editing);
    if (editing) fName.focus();
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (saveBtn.disabled || !validate("all")) return;
    const locationStatus = () => (saveBtn.disabled ? status.textContent ?? "" : "");

    isSaving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    setStatus("");

    const picked = (field: HTMLSelectElement) => field.value ? field.selectedOptions[0]?.textContent ?? null : null;
    const submitted = {
      name: fName.value.trim(),
      address: fAddress.value.trim(),
      city: fCity.value,
      cityName: picked(fCity),
      zone: fZone.value,
      zoneName: picked(fZone),
      area: fArea.value,
      areaName: picked(fArea),
    };
    const res = await updateCustomerProfile({
      name: submitted.name,
      address: submitted.address,
      city: submitted.city,
      zone: submitted.zone,
      area: submitted.area,
    });

    if (accountWindow.__scaliusAccountInitRun !== runId) return;
    isSaving = false;
    updateSaveAvailability();
    saveBtn.textContent = "Save address";

    if (!res.success) {
      const error = res.unavailable ? ACCOUNT_OFFLINE_MESSAGE : res.error || ACCOUNT_OFFLINE_MESSAGE;
      setStatus([error, locationStatus()].filter(Boolean).join(" "));
      return;
    }
    customer = res.customer ?? { ...customer, ...submitted };
    renderProfile(customer);
    // A location changed while saving: keep the form open on that edit.
    if (locationStatus()) return;
    setEditing(false);
    saved.classList.remove("hidden");
  };

  bindProfileNameEditor(runId, () => customer, (saved) => {
    customer = saved;
    renderProfile(customer);
    if (form.classList.contains("hidden")) fName.value = customer.name ?? "";
  });
  fName.value = customer.name ?? "";
  fAddress.value = customer.address ?? "";
  await loadLocations();
  await ordersRead;
}

/** Signing out clears the checkout draft too (listeners on "customer-logout"). */
export function bindSignOut(): void {
  const signOutForm = document.getElementById("signOutForm") as HTMLFormElement | null;
  if (!signOutForm) return;
  signOutForm.onsubmit = async (event) => {
    event.preventDefault();
    await logoutCustomer();
    window.dispatchEvent(new CustomEvent("customer-logout"));
    window.location.assign("/");
  };
}
