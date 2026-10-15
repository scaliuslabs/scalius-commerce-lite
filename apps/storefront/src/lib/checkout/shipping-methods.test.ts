// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enhanceShippingMethods,
  fetchDeliveryRates,
  overlayQuotedRates,
  type DeliveryAddress,
  type DeliveryRate,
  type ShippingMethodDetail,
} from "./shipping-methods";
import type { CheckoutDeliveryMode } from "./delivery-mode";

const rate = (id: string, fee: number, extra: Partial<DeliveryRate> = {}): DeliveryRate => ({
  id,
  name: id,
  fee,
  description: null,
  freeOver: null,
  kind: "delivery",
  pickupAddress: null,
  pickupHours: null,
  ...extra,
});

const DHAKA = { cityId: "dhaka", zoneId: "mirpur", areaId: "" };
const CTG = { cityId: "ctg", zoneId: "agrabad", areaId: "" };
const standard = rate("standard", 80);
const ctg = rate("ctg", 150, { freeOver: 3000 });
const pickup = rate("pickup", 0, { kind: "pickup", pickupAddress: "Shop 12, Dhanmondi", pickupHours: "10am–8pm" });

afterEach(() => {
  document.body.innerHTML = "";
  delete window.lastShippingEventDetail;
});

function setup(options: {
  byCity?: Record<string, DeliveryRate[] | null>;
  draft?: string;
  subtotal?: () => number;
  waived?: () => boolean;
  loadRates?: (address: DeliveryAddress) => Promise<DeliveryRate[] | null>;
  modeSwitch?: boolean;
  readMode?: () => CheckoutDeliveryMode;
} = {}) {
  document.body.innerHTML = `
    <div data-shipping-methods data-mode-switch="${options.modeSwitch ? "true" : "false"}" data-delivery-legend-text="Choose delivery option" data-pickup-legend-text="Choose a pickup location" data-pickup-hours-text="Open {hours}" data-free-text="Free" data-free-over-text="Free over {amount}"
      data-waived-text="Normally {fee}; waived." data-pickup-from-text="Pick up from {address}"
      data-choose-address-text="Choose your city and zone." data-no-delivery-text="We don't deliver here yet."
      data-failed-text="Couldn't load." data-retry-text="Retry" data-loading-text="Loading…"
      data-fee-changed-text="Delivery fee changed from {old} to {new}." data-replaced-text="{old} is gone, so {new} is selected. Delivery was {oldFee}, now {newFee}."
      data-replaced-same-fee-text="{old} is gone, so {new} ({fee}) is selected."
      data-gone-text="{old} is gone.">
      <script type="application/json" data-shipping-rates>${JSON.stringify([standard, ctg, pickup])}</script>
      <fieldset id="shippingMethods"><legend data-shipping-legend>Choose delivery option</legend><p data-shipping-note></p><p data-shipping-notice class="hidden"></p><div data-shipping-options></div></fieldset>
    </div>`;
  const events: Array<ShippingMethodDetail | null> = [];
  window.addEventListener("shippingLocationChange", (event) =>
    events.push((event as CustomEvent<ShippingMethodDetail | null>).detail));
  const loadRates = options.loadRates
    ?? vi.fn(async (address: DeliveryAddress) => options.byCity?.[address.cityId] ?? null);
  const methods = enhanceShippingMethods(document, {
    loadRates,
    readDraftMethod: () => options.draft,
    readSubtotal: options.subtotal ?? (() => 1000),
    isFeeWaived: options.waived ?? (() => false),
    formatMoney: (amount) => `৳${amount.toLocaleString("en-IN")}`,
    ...(options.readMode ? { readMode: options.readMode } : {}),
  })!;
  const options_ = () =>
    [...document.querySelectorAll<HTMLElement>("[data-rate-id]")].map((option) => ({
      id: option.dataset.rateId,
      checked: option.querySelector("input")!.checked,
      fee: option.querySelector("[data-fee-label]")!.textContent,
      note: option.querySelector<HTMLElement>("[data-fee-note]")!.classList.contains("hidden")
        ? ""
        : option.querySelector("[data-fee-note]")!.textContent,
    }));
  const note = () => document.querySelector("[data-shipping-note]")!.textContent?.trim();
  // "Choose an address" stands in the options' place, at an option's size.
  const standIn = () => document.querySelector("[data-shipping-options] > p")?.textContent?.trim() ?? "";
  return { methods, events, loadRates, options: options_, note, standIn };
}

describe("delivery options follow the address", () => {
  it("shows a pending carrier price until the quote arrives and keeps the known product waiver", async () => {
    let waived = false;
    const { methods, events, options } = setup({
      byCity: { dhaka: [rate("carrier", 0, { rateSource: "app.carrier:standard" })] },
      waived: () => waived,
    });
    await methods.setAddress(DHAKA);
    expect(options()[0]).toMatchObject({ fee: "Loading…", note: "" });
    expect(events.at(-1)).toMatchObject({ rateSource: "app.carrier:standard" });
    methods.applyQuotedRates([{ id: "carrier", name: "Carrier", kind: "delivery", amount: 125, amountMinor: 12_500 }]);
    expect(options()[0]).toMatchObject({ fee: "৳125", note: "" });
    methods.applyQuotedRates(null);
    waived = true;
    methods.refreshFees();
    expect(options()[0]).toMatchObject({ fee: "Free", note: "" });
  });

  it("rechecks a flat zero fee changed to a carrier quote without calling it free", async () => {
    const loadRates = vi.fn()
      .mockResolvedValueOnce([rate("standard", 0)])
      .mockResolvedValueOnce([rate("standard", 0, { rateSource: "app.carrier:standard" })]);
    const { methods, options } = setup({ loadRates });
    await methods.setAddress(DHAKA);
    expect(await methods.recheck()).toBe(true);
    expect(options()[0]).toMatchObject({ fee: "Loading…" });
    expect(document.querySelector("[data-shipping-notice]")?.textContent).toBe("Delivery fee changed from Free to Loading….");
  });

  it("offers only pickup before an address, with nothing chosen", () => {
    const { events, options, note, standIn } = setup();
    expect(options()).toEqual([{ id: "pickup", checked: false, fee: "Free", note: "" }]);
    expect(standIn()).toBe("Choose your city and zone.");
    expect(note()).toBe("");
    expect(events).toEqual([null]);
    expect(window.lastShippingEventDetail).toBeUndefined();
    expect(document.body.textContent).toContain("Pick up from Shop 12, Dhanmondi");
  });

  it("re-reads the rates for each address and replaces a rate that no longer applies", async () => {
    const { methods, events, loadRates, options, note, standIn } = setup({
      byCity: { dhaka: [standard, pickup], ctg: [ctg, pickup] },
    });
    await methods.setAddress(DHAKA);
    expect(loadRates).toHaveBeenLastCalledWith(DHAKA);
    expect(options().map(({ id, checked }) => [id, checked])).toEqual([["standard", true], ["pickup", false]]);
    expect(events.at(-1)).toEqual({ id: "standard", fee: 80, freeOver: null, name: "standard", kind: "delivery" });
    expect(note()).toBe("");

    const announced = events.length;
    const switching = methods.setAddress(CTG);
    // Nothing is quoted against the Dhaka rate while Chattogram's load, and
    // the totals hear once, when they arrive: one quote per address.
    expect(window.lastShippingEventDetail).toBeUndefined();
    expect(document.querySelectorAll("[data-shipping-options] .theme-skeleton")).toHaveLength(2);
    expect(standIn()).toBe("");
    await switching;
    expect(options().map(({ id, checked }) => [id, checked])).toEqual([["ctg", true], ["pickup", false]]);
    expect(window.lastShippingEventDetail?.id).toBe("ctg");
    expect(events.slice(announced).map((event) => event?.id)).toEqual(["ctg"]);
  });

  it("says free over the threshold, then free once the subtotal reaches it", async () => {
    let subtotal = 2500;
    const { methods, options } = setup({ byCity: { ctg: [ctg] }, subtotal: () => subtotal });
    await methods.setAddress(CTG);
    expect(options()[0]).toMatchObject({ fee: "৳150", note: "Free over ৳3,000" });
    subtotal = 3000;
    methods.refreshFees();
    expect(options()[0]).toMatchObject({ fee: "Free", note: "" });
  });

  it("keeps the buyer's choice while it still applies", async () => {
    const { methods, options } = setup({ byCity: { dhaka: [standard, pickup], ctg: [ctg, pickup] } });
    await methods.setAddress(DHAKA);
    const pickupInput = document.querySelector<HTMLInputElement>('input[value="pickup"]')!;
    pickupInput.checked = true;
    pickupInput.dispatchEvent(new Event("change", { bubbles: true }));
    await methods.setAddress(CTG);
    expect(options().find(({ checked }) => checked)?.id).toBe("pickup");
  });

  it("restores the drafted rate when the address offers it", async () => {
    const { methods, options } = setup({ byCity: { dhaka: [standard, rate("express", 150)] }, draft: "express" });
    await methods.setAddress(DHAKA);
    expect(options().find(({ checked }) => checked)?.id).toBe("express");
  });

  it("says the store doesn't deliver there and still offers pickup", async () => {
    const { methods, options, note, events } = setup({ byCity: { remote: [pickup] } });
    await methods.setAddress({ cityId: "remote", zoneId: "far", areaId: "" });
    expect(note()).toBe("We don't deliver here yet.");
    expect(options()).toEqual([{ id: "pickup", checked: false, fee: "Free", note: "" }]);
    expect(events.at(-1)).toBeNull();
  });

  it("reads another country's rates by its region and postal code, never Bangladesh's ids (MARKETS-DESIGN step 3b)", async () => {
    const us = rate("us", 2500);
    const loadRates = vi.fn(async (address: DeliveryAddress) => (address.countryCode === "US" && address.postalCode === "94103" ? [us, pickup] : [pickup]));
    const { methods, options, note } = setup({ loadRates });
    await methods.setAddress({ countryCode: "US", cityId: "", zoneId: "", areaId: "", adminArea: "CA", postalCode: "94103" });
    expect(options()).toEqual([
      { id: "us", checked: true, fee: "৳2,500", note: "" },
      { id: "pickup", checked: false, fee: "Free", note: "" },
    ]);
    // A postal code no zone serves: no delivery, and the note says so.
    await methods.setAddress({ countryCode: "US", cityId: "", zoneId: "", areaId: "", adminArea: "NY", postalCode: "10001" });
    expect(note()).toBe("We don't deliver here yet.");
    expect(loadRates).toHaveBeenCalledTimes(2);
  });

  it("asks the API for a destination's zone in its own query", async () => {
    const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify({ success: true, data: { shippingMethods: [] } }), { status: 200 }));
    await fetchDeliveryRates("https://api.example.test/api/v1", { countryCode: "GB", cityId: "", zoneId: "", areaId: "", postalCode: "SW1A 1AA" }, fetchImpl as never);
    await fetchDeliveryRates("https://api.example.test/api/v1", DHAKA, fetchImpl as never);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/api/v1/shipping-methods?countryCode=GB&postalCode=SW1A+1AA",
      // Bangladesh's query is as before.
      "https://api.example.test/api/v1/shipping-methods?cityId=dhaka&zoneId=mirpur",
    ]);
  });

  it("offers a retry when the rates can't be read", async () => {
    let fail = true;
    const { methods, options } = setup({
      loadRates: async () => (fail ? null : [standard]),
    });
    await methods.setAddress(DHAKA);
    expect(document.querySelector("[data-shipping-note]")!.textContent).toContain("Couldn't load.");
    fail = false;
    document.querySelector<HTMLButtonElement>("[data-shipping-note] button")!.click();
    await vi.waitFor(() => expect(options()[0]).toMatchObject({ id: "standard", checked: true }));
  });

  it("drops a rate the checkout refused and chooses again", async () => {
    const { methods, options, loadRates } = setup({
      byCity: { dhaka: [standard, rate("express", 150)] },
    });
    await methods.setAddress(DHAKA);
    await methods.rejectSelected();
    expect(loadRates).toHaveBeenCalledTimes(2);
    expect(options().map(({ id, checked }) => [id, checked])).toEqual([["express", true]]);
  });

  it("says the delivery fee changed before the order is placed, and blocks that submit", async () => {
    let offered = [rate("standard", 60)];
    const { methods, events } = setup({ loadRates: async () => offered });
    await methods.setAddress(DHAKA);
    const notice = () => document.querySelector<HTMLElement>("[data-shipping-notice]")!;
    await expect(methods.recheck()).resolves.toBe(false);
    expect(notice().classList.contains("hidden")).toBe(true);

    offered = [rate("standard", 80)];
    await expect(methods.recheck()).resolves.toBe(true);
    expect(notice().textContent).toBe("Delivery fee changed from ৳60 to ৳80.");
    expect(events.at(-1)).toMatchObject({ id: "standard", fee: 80 });
    // The buyer reviewed it: the next submit goes through.
    await expect(methods.recheck()).resolves.toBe(false);
  });

  it("does not block checkout or announce a price change when the waived base rate changes", async () => {
    let offered = [rate("standard", 80)];
    const { methods, options, events } = setup({ loadRates: async () => offered, waived: () => true });
    await methods.setAddress(DHAKA);
    offered = [rate("standard", 120)];
    await expect(methods.recheck()).resolves.toBe(false);
    expect(options()[0]).toMatchObject({ fee: "Free", note: "Normally ৳120; waived." });
    expect(events.at(-1)).toMatchObject({ fee: 120 });
    expect(document.querySelector("[data-shipping-notice]")!.textContent).toBe("");
  });

  it("compares what is paid when only a free-over threshold changes", async () => {
    let offered = [rate("standard", 80, { freeOver: 3000 })];
    const { methods } = setup({ loadRates: async () => offered, subtotal: () => 1000 });
    await methods.setAddress(DHAKA);
    offered = [rate("standard", 80, { freeOver: 2000 })];
    await expect(methods.recheck()).resolves.toBe(false);
    expect(document.querySelector("[data-shipping-notice]")!.textContent).toBe("");
    offered = [rate("standard", 80, { freeOver: 1000 })];
    await expect(methods.recheck()).resolves.toBe(true);
    expect(document.querySelector("[data-shipping-notice]")!.textContent).toBe("Delivery fee changed from ৳80 to Free.");
  });

  it("names the rate that replaced one the merchant removed", async () => {
    let offered = [rate("zone60", 60), rate("standard", 80)];
    const { methods, options } = setup({ loadRates: async () => offered });
    await methods.setAddress(DHAKA);
    offered = [rate("standard", 80)];
    await expect(methods.recheck()).resolves.toBe(true);
    expect(document.querySelector("[data-shipping-notice]")!.textContent)
      .toBe("zone60 is gone, so standard is selected. Delivery was ৳60, now ৳80.");
    expect(options().find(({ checked }) => checked)?.id).toBe("standard");
    // Choosing an option clears the notice.
    document.querySelector<HTMLInputElement>('input[value="standard"]')!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector("[data-shipping-notice]")!.classList.contains("hidden")).toBe(true);
  });

  it("says delivery went from Free to a fee, and gives a same-priced replacement its fee", async () => {
    let offered = [rate("zone0", 0), rate("standard", 80)];
    const { methods } = setup({ loadRates: async () => offered });
    await methods.setAddress(DHAKA);
    offered = [rate("standard", 80)];
    await expect(methods.recheck()).resolves.toBe(true);
    expect(document.querySelector("[data-shipping-notice]")!.textContent)
      .toBe("zone0 is gone, so standard is selected. Delivery was Free, now ৳80.");

    offered = [rate("other", 80)];
    await expect(methods.recheck()).resolves.toBe(true);
    expect(document.querySelector("[data-shipping-notice]")!.textContent).toBe("standard is gone, so other (৳80) is selected.");
  });

  it("ignores rates that arrive for an address the buyer already left", async () => {
    let releaseDhaka: (rates: DeliveryRate[]) => void = () => {};
    const { methods, options } = setup({
      loadRates: (address) =>
        address.cityId === "dhaka"
          ? new Promise((resolve) => { releaseDhaka = resolve; })
          : Promise.resolve([ctg]),
    });
    const dhaka = methods.setAddress(DHAKA);
    await methods.setAddress(CTG);
    releaseDhaka([standard]);
    await dhaka;
    expect(options().map(({ id }) => id)).toEqual(["ctg"]);
  });

  it("says in words when a cart item waives the delivery fee", async () => {
    let waived = false;
    const { methods, options } = setup({ byCity: { dhaka: [standard] }, waived: () => waived });
    await methods.setAddress(DHAKA);
    waived = true;
    methods.refreshFees();
    expect(options()[0]).toMatchObject({ fee: "Free", note: "Normally ৳80; waived." });
  });
});

describe("delivery options follow the Delivery/Pickup switch", () => {
  it("lists only pickup locations on the pickup path, with no address, and chooses a single one", async () => {
    let mode: CheckoutDeliveryMode = "delivery";
    const { methods, options, note, events, standIn } = setup({
      modeSwitch: true,
      readMode: () => mode,
      byCity: { dhaka: [standard, pickup] },
    });
    // Delivery before an address: nothing to choose, pickup is on its own tab.
    expect(options()).toEqual([]);
    expect(standIn()).toBe("Choose your city and zone.");

    mode = "pickup";
    await methods.setMode("pickup");
    expect(options()).toEqual([{ id: "pickup", checked: true, fee: "Free", note: "" }]);
    expect(note()).toBe("");
    expect(document.querySelector("[data-shipping-legend]")?.textContent).toBe("Choose a pickup location");
    expect(document.body.textContent).toContain("Open 10am–8pm");
    expect(events.at(-1)).toMatchObject({ id: "pickup", kind: "pickup", pickupAddress: "Shop 12, Dhanmondi" });

    // Back to delivery: the address's rates, never the pickup location.
    mode = "delivery";
    await methods.setMode("delivery");
    await methods.setAddress(DHAKA);
    expect(options().map(({ id }) => id)).toEqual(["standard"]);
    expect(events.at(-1)).toMatchObject({ id: "standard", kind: "delivery" });
  });

  it("chooses nothing when nothing in the cart is physical", async () => {
    let mode: CheckoutDeliveryMode = "delivery";
    const { methods, options, events } = setup({ modeSwitch: true, readMode: () => mode, byCity: { dhaka: [standard] } });
    await methods.setAddress(DHAKA);
    expect(events.at(-1)).toMatchObject({ id: "standard" });
    mode = "none";
    await methods.setMode("none");
    expect(options()).toEqual([]);
    expect(events.at(-1)).toBeNull();
    expect(window.lastShippingEventDetail).toBeUndefined();
    await expect(methods.recheck()).resolves.toBe(false);
  });
});

describe("delivery options a store app changed for this cart", () => {
  const express = rate("express", 150, { freeOver: 3000 });
  const appRates = [
    { id: "express", name: "Express (app)", kind: "delivery" as const, amount: 99, amountMinor: 9_900 },
    { id: "standard", name: "Standard", kind: "delivery" as const, amount: 0, amountMinor: 0 },
  ];

  it("shows only the options the quote lists, in its order, with its names and fees", () => {
    expect(overlayQuotedRates([standard, express, pickup], appRates)).toEqual([
      { ...express, name: "Express (app)", fee: 99, freeOver: null, quoted: true },
      { ...standard, name: "Standard", fee: 0, freeOver: null, quoted: true },
    ]);
    // An option this path does not offer is never added; null leaves the list as read.
    expect(overlayQuotedRates([standard], [{ ...appRates[0]!, id: "unknown" }])).toEqual([]);
    expect(overlayQuotedRates([standard, express], null)).toEqual([standard, express]);
  });

  it("renames, reprices and reorders the cards, keeps the buyer's visible choice, and takes it back with null", async () => {
    const { methods, options, events } = setup({ byCity: { dhaka: [standard, express] } });
    await methods.setAddress(DHAKA);
    expect(events.at(-1)).toMatchObject({ id: "standard", fee: 80 });

    methods.applyQuotedRates(appRates);
    expect(options()).toEqual([
      // The quote's fee is what the buyer pays: no free-over note.
      { id: "express", checked: false, fee: "৳99", note: "" },
      { id: "standard", checked: true, fee: "Free", note: "" },
    ]);
    expect(document.querySelector('[data-rate-id="express"]')?.textContent).toContain("Express (app)");
    // The totals hear the fee the buyer pays, with no threshold left to apply.
    expect(events.at(-1)).toEqual({ id: "standard", fee: 0, freeOver: null, name: "Standard", kind: "delivery", quoted: true });
    const announced = events.length;
    methods.applyQuotedRates(appRates.map((entry) => ({ ...entry })));
    expect(events).toHaveLength(announced);
    // The quote prices these options and the order checks it: nothing to re-read.
    await expect(methods.recheck()).resolves.toBe(false);

    methods.applyQuotedRates(null);
    expect(options().map(({ id, fee }) => [id, fee])).toEqual([["standard", "৳80"], ["express", "৳150"]]);
    expect(events.at(-1)).toEqual({ id: "standard", fee: 80, freeOver: null, name: "standard", kind: "delivery" });
  });

  it("honors an app's quoted charge even when a cart item normally waives delivery", async () => {
    const { methods, options } = setup({ byCity: { dhaka: [standard] }, waived: () => true });
    await methods.setAddress(DHAKA);
    expect(options()[0]?.fee).toBe("Free");
    methods.applyQuotedRates([{ id: "standard", name: "App delivery", kind: "delivery", amount: 80, amountMinor: 8000 }]);
    expect(options()[0]).toMatchObject({ fee: "৳80", note: "" });
  });

  it("chooses the first option left when an app hides the chosen one", async () => {
    const { methods, options, events } = setup({ byCity: { dhaka: [standard, express] } });
    await methods.setAddress(DHAKA);
    methods.applyQuotedRates([appRates[0]!]);
    expect(options()).toEqual([{ id: "express", checked: true, fee: "৳99", note: "" }]);
    expect(events.at(-1)).toMatchObject({ id: "express", fee: 99, quoted: true });
  });

  it("drops a refused option, picks the first one the app left, and says what changed", async () => {
    const { methods, options, events } = setup({ byCity: { dhaka: [standard, express] } });
    await methods.setAddress(DHAKA);
    // The refusal lists the options still offered (never the refused one, even if repeated).
    await methods.rejectSelected([appRates[1]!, appRates[0]!]);
    expect(options()).toEqual([{ id: "express", checked: true, fee: "৳99", note: "" }]);
    expect(events.at(-1)).toMatchObject({ id: "express", fee: 99 });
    expect(document.querySelector("[data-shipping-notice]")!.textContent)
      .toBe("standard is gone, so Express (app) is selected. Delivery was ৳80, now ৳99.");
  });

  it("forgets an earlier quote's options when the address changes", async () => {
    const { methods, options } = setup({ byCity: { dhaka: [standard, express], ctg: [ctg] } });
    await methods.setAddress(DHAKA);
    methods.applyQuotedRates([appRates[0]!]);
    await methods.setAddress(CTG);
    expect(options().map(({ id, fee }) => [id, fee])).toEqual([["ctg", "৳150"]]);
  });

  it("ignores a quote for the address the buyer left that answers while the new options load", async () => {
    let releaseCtg: (rates: DeliveryRate[]) => void = () => {};
    const { methods, options } = setup({
      loadRates: (address) =>
        address.cityId === "ctg"
          ? new Promise((resolve) => { releaseCtg = resolve; })
          : Promise.resolve([standard, express]),
    });
    await methods.setAddress(DHAKA);
    const moving = methods.setAddress(CTG);
    // Dhaka's quote lands late: its options must not filter Chattogram's.
    methods.applyQuotedRates([appRates[0]!]);
    releaseCtg([ctg]);
    await moving;
    expect(options().map(({ id, checked }) => [id, checked])).toEqual([["ctg", true]]);
  });
});

describe("fetchDeliveryRates", () => {
  it("asks for the address's rates and reads freeOver, kind and pickup facts", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { shippingMethods: [{ ...ctg, isActive: true, sortOrder: 0, createdAt: null, updatedAt: null }] },
    })));
    const rates = await fetchDeliveryRates("https://api.example/api/v1", { ...CTG, areaId: "a1" }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example/api/v1/shipping-methods?cityId=ctg&zoneId=agrabad&areaId=a1",
      expect.anything(),
    );
    expect(rates).toEqual([ctg]);
    const failing = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(fetchDeliveryRates("https://api.example/api/v1", CTG, failing)).resolves.toBeNull();
  });
});
