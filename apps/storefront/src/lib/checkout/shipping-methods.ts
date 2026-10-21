/**
 * Delivery options on /cart (components/checkout/CheckoutShippingMethods.astro).
 *
 * The list follows the checkout path (`lib/checkout/delivery-mode.ts`):
 * - delivery: the options follow the address; every change of its
 *   destination re-reads the rates of its shipping zone
 *   (`GET /shipping-methods?cityId&zoneId&areaId` in Bangladesh,
 *   `?countryCode&adminArea&postalCode` elsewhere; MARKETS-DESIGN step 3b),
 *   keeps the buyer's choice while it still applies and otherwise selects the
 *   first delivery rate. Pickup rates are listed here only when the store has
 *   no Delivery/Pickup switch (then pickup is always listed, and alone before
 *   an address);
 * - pickup: only the store's pickup locations, no address needed;
 * - none: nothing to choose (nothing physical in the cart).
 * Other cart code reads the choice from `window.lastShippingEventDetail` and
 * the `shippingLocationChange` event (detail `null` while nothing applies).
 *
 * A store app may change the options for this cart: the quote then lists the
 * ones to show (`applyQuotedRates`), in its order, with its names and fees.
 */
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import type { ShippingMethod } from "@/lib/api";
import type { CheckoutDeliveryMode } from "./delivery-mode";
import type { QuotedShippingRate } from "./tax-quote-contract";
import { fetchWithTransientRetry } from "../transient-fetch";

export type DeliveryRate = Pick<ShippingMethod, "id" | "name" | "fee" | "description" | "rateSource"> & {
  freeOver: number | null;
  kind: "delivery" | "pickup";
  pickupAddress: string | null;
  pickupHours: string | null;
  /** Name and fee come from the quote (a store app changed them): the fee is what the buyer pays. */
  quoted?: true;
};

export interface ShippingMethodDetail {
  id: string;
  rateSource?: string;
  /** The rate's own charge; see `getEffectiveCartShippingFee` for what the buyer pays. */
  fee: number;
  freeOver: number | null;
  name: string;
  kind: "delivery" | "pickup";
  /** Pickup rates: where and when to collect. */
  pickupAddress?: string | null;
  pickupHours?: string | null;
  /** The fee is the quote's (a store app priced this option): no free-over threshold applies. */
  quoted?: true;
}

/** A carrier's stored fee is a placeholder until checkout receives a quote. */
export function hasPendingShippingRate(rate: { rateSource?: string; quoted?: true }): boolean {
  return Boolean(rate.rateSource && rate.rateSource !== "flat" && !rate.quoted);
}

/**
 * The options as a store app left them on the quote: only the ones it lists,
 * in its order, with its names and fees (what the buyer pays, so no free-over
 * threshold is left to apply). An option this path does not offer is never
 * added. Null (no app changed them) leaves the options as they are.
 */
export function overlayQuotedRates<Rate extends { id: string; name: string; fee: number }>(
  rates: readonly Rate[],
  quoted: readonly QuotedShippingRate[] | null,
): Array<Rate | (Rate & { freeOver: null; quoted: true })> {
  if (!quoted) return [...rates];
  const byId = new Map(rates.map((rate) => [rate.id, rate]));
  return quoted.flatMap((entry) => {
    const rate = byId.get(entry.id);
    return rate
      ? [{ ...rate, name: entry.name, fee: entry.amount, freeOver: null, quoted: true as const }]
      : [];
  });
}

export interface DeliveryAddress {
  /** ISO country; empty or BD: Bangladesh, whose City/Thana/Area ids follow. */
  countryCode?: string;
  cityId: string;
  zoneId: string;
  areaId: string;
  /** Another country's region and postal code: its shipping zone matches on them. */
  adminArea?: string;
  postalCode?: string;
}

/** Another country than Bangladesh. */
function isForeign(address: DeliveryAddress): boolean {
  return Boolean(address.countryCode) && address.countryCode !== "BD";
}

/** Enough to read a zone's rates: Bangladesh's city and thana, or another country. */
export function hasDeliveryDestination(address: DeliveryAddress): boolean {
  return isForeign(address) || Boolean(address.cityId && address.zoneId);
}

export interface ShippingMethodsCopy {
  freeText: string;
  freeOverText: string;
  waivedShippingFeeText: string;
  pickupFromText: string;
  chooseAddressText: string;
  noDeliveryText: string;
  /** The options couldn't be read while the browser is offline: check the connection. */
  failedText: string;
  /** The options couldn't be read from the store (the buyer is online). */
  unavailableText: string;
  retryText: string;
  loadingText: string;
  feeChangedText: string;
  replacedText: string;
  replacedSameFeeText: string;
  goneText: string;
  /** Legend text per path. */
  deliveryLegendText: string;
  pickupLegendText: string;
  pickupHoursText: string;
}

export function toDeliveryRate(method: ShippingMethod): DeliveryRate {
  return {
    id: method.id,
    name: method.name,
    fee: method.fee,
    ...(method.rateSource ? { rateSource: method.rateSource } : {}),
    description: method.description ?? null,
    freeOver: typeof method.freeOver === "number" ? method.freeOver : null,
    kind: method.kind === "pickup" ? "pickup" : "delivery",
    pickupAddress: method.pickupAddress ?? null,
    pickupHours: method.pickupHours ?? null,
  };
}

/** Waits before repeating a rates read that failed in transit (no connection, a timeout, a 5xx or a 429). */
export const DELIVERY_RATES_RETRY_DELAYS_MS = [400, 1200] as const;
const DELIVERY_RATES_TIMEOUT_MS = 8_000;

/**
 * The rates offered for an address, or null when they couldn't be read. A
 * read that fails in transit is repeated (as the city and thana lists are)
 * before the buyer is told; a refusal (4xx) or an unreadable answer is not.
 */
export async function fetchDeliveryRates(
  apiBaseUrl: string,
  address: DeliveryAddress,
  fetchImpl: typeof fetch = fetch,
  delays: readonly number[] = DELIVERY_RATES_RETRY_DELAYS_MS,
): Promise<DeliveryRate[] | null> {
  const query = new URLSearchParams();
  if (isForeign(address)) {
    query.set("countryCode", address.countryCode!);
    if (address.adminArea) query.set("adminArea", address.adminArea);
    if (address.postalCode) query.set("postalCode", address.postalCode);
  } else {
    query.set("cityId", address.cityId);
    query.set("zoneId", address.zoneId);
    if (address.areaId) query.set("areaId", address.areaId);
  }
  try {
    const response = await fetchWithTransientRetry(
      fetchImpl,
      `${apiBaseUrl}/shipping-methods?${query}`,
      { headers: { Accept: "application/json" } },
      delays,
      { timeoutMs: DELIVERY_RATES_TIMEOUT_MS },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      success?: unknown;
      data?: { shippingMethods?: unknown };
    };
    const methods = body.success === true ? body.data?.shippingMethods : null;
    return Array.isArray(methods)
      ? methods
          .filter((method): method is ShippingMethod =>
            typeof method?.id === "string" && typeof method?.name === "string" && typeof method?.fee === "number")
          .map(toDeliveryRate)
      : null;
  } catch {
    return null;
  }
}

/**
 * Why the options couldn't be read, in words that are true: the buyer's
 * connection only when the browser says it is offline; otherwise the store's
 * side, never the buyer's.
 */
export function deliveryRatesFailedText(
  copy: Pick<ShippingMethodsCopy, "failedText" | "unavailableText">,
  online: boolean = typeof navigator === "undefined" || navigator.onLine !== false,
): string {
  return online ? copy.unavailableText : copy.failedText;
}

/** One delivery option's height; its loading and empty stand-ins match it. */
const OPTION_HEIGHT = "min-h-[4.25rem]";

const addressKey = (address: DeliveryAddress) => isForeign(address)
  ? `${address.countryCode}|${address.adminArea ?? ""}|${address.postalCode ?? ""}`
  : `${address.cityId}|${address.zoneId}|${address.areaId}`;

export function enhanceShippingMethods(
  root: ParentNode,
  options: {
    loadRates: (address: DeliveryAddress) => Promise<DeliveryRate[] | null>;
    readDraftMethod: () => string | undefined;
    /** Items subtotal before discounts, for free-over thresholds. */
    readSubtotal: () => number;
    isFeeWaived: () => boolean;
    formatMoney: (amount: number) => string;
    /** The checkout path; delivery when not given. */
    readMode?: () => CheckoutDeliveryMode;
    /**
     * Why the address can have no delivery rate (a country no shipping zone
     * serves), said in place of "choose an address" and of "we don't deliver
     * there"; null when it can.
     */
    readNoDeliveryReason?: () => string | null;
    signal?: AbortSignal;
  },
): {
  refreshFees(): void;
  setAddress(address: Partial<DeliveryAddress>): Promise<void>;
  /** The buyer switched Delivery/Pickup, or the cart gained or lost its last physical line. */
  setMode(mode: CheckoutDeliveryMode): Promise<void>;
  /**
   * The checkout refused the chosen rate: drop it, re-read the address's rates
   * and say what changed. When a store app hid it, `shippingRates` are the
   * options still offered and the first of them is chosen.
   */
  rejectSelected(shippingRates?: QuotedShippingRate[] | null): Promise<void>;
  /** The latest quote's options when a store app changed them, or null to show the store's own. */
  applyQuotedRates(shippingRates: QuotedShippingRate[] | null): void;
  /**
   * Before placing the order: re-reads the address's rates and, when the chosen
   * rate is gone or its fee changed, shows what changed and returns true so the
   * buyer reviews the new total before placing the order.
   */
  recheck(): Promise<boolean>;
} | null {
  const container = root.querySelector<HTMLElement>("[data-shipping-methods]");
  const list = container?.querySelector<HTMLElement>("[data-shipping-options]");
  const note = container?.querySelector<HTMLElement>("[data-shipping-note]");
  const notice = container?.querySelector<HTMLElement>("[data-shipping-notice]");
  if (!container || !list || !note) return null;

  const data = container.dataset;
  const copy: ShippingMethodsCopy = {
    freeText: data.freeText || "",
    freeOverText: data.freeOverText || "",
    waivedShippingFeeText: data.waivedText || "",
    pickupFromText: data.pickupFromText || "",
    chooseAddressText: data.chooseAddressText || "",
    noDeliveryText: data.noDeliveryText || "",
    failedText: data.failedText || "",
    unavailableText: data.unavailableText || data.failedText || "",
    retryText: data.retryText || "",
    loadingText: data.loadingText || "",
    feeChangedText: data.feeChangedText || "",
    replacedText: data.replacedText || "",
    replacedSameFeeText: data.replacedSameFeeText || "",
    goneText: data.goneText || "",
    deliveryLegendText: data.deliveryLegendText || "",
    pickupLegendText: data.pickupLegendText || "",
    pickupHoursText: data.pickupHoursText || "",
  };
  const legend = container.querySelector<HTMLElement>("[data-shipping-legend]");
  let initialRates: DeliveryRate[] = [];
  try {
    const parsed = JSON.parse(container.querySelector("script[data-shipping-rates]")?.textContent || "[]");
    if (Array.isArray(parsed)) initialRates = parsed.map(toDeliveryRate);
  } catch {
    initialRates = [];
  }
  const pickupRates = initialRates.filter((rate) => rate.kind === "pickup");
  // With a Delivery/Pickup switch each path lists only its own rates.
  const hasModeSwitch = container.dataset.modeSwitch === "true";
  const readMode = options.readMode ?? (() => "delivery" as CheckoutDeliveryMode);
  let mode: CheckoutDeliveryMode = readMode();
  const addressFreeRates = () => (mode === "pickup" || !hasModeSwitch ? pickupRates : []);

  let rates: DeliveryRate[] = mode === "none" ? [] : addressFreeRates();
  /** The options a store app left on the latest quote; null shows `rates` as read. */
  let overlay: QuotedShippingRate[] | null = null;
  const shown = (): DeliveryRate[] => overlayQuotedRates(rates, overlay);
  let selectedId: string | null = null;
  let preferredId: string | null = options.readDraftMethod() ?? null;
  let address: DeliveryAddress = { cityId: "", zoneId: "", areaId: "" };
  let sequence = 0;
  const rejected = new Set<string>();
  // What the totals were last told: the same rate for the same address is
  // not announced twice (each announcement re-quotes the order).
  let announced: string | undefined;

  const emit = () => {
    const rate = shown().find((candidate) => candidate.id === selectedId) ?? null;
    const detail: ShippingMethodDetail | null = rate
      ? {
          id: rate.id,
          fee: rate.fee,
          ...(rate.rateSource ? { rateSource: rate.rateSource } : {}),
          freeOver: rate.freeOver,
          name: rate.name,
          kind: rate.kind,
          ...(rate.kind === "pickup"
            ? { pickupAddress: rate.pickupAddress, pickupHours: rate.pickupHours }
            : {}),
          ...(rate.quoted ? { quoted: true as const } : {}),
        }
      : null;
    window.lastShippingEventDetail = detail ?? undefined;
    const key = detail ? `${JSON.stringify(detail)}|${addressKey(address)}` : "none";
    if (key === announced) return;
    announced = key;
    window.dispatchEvent(new CustomEvent("shippingLocationChange", { detail }));
  };

  const renderLegend = () => {
    if (!legend) return;
    const text = mode === "pickup" ? copy.pickupLegendText : copy.deliveryLegendText;
    if (text && legend.textContent !== text) legend.textContent = text;
  };

  const setNote = (text: string, retry = false) => {
    note.textContent = text;
    note.classList.remove("sr-only");
    note.classList.toggle("hidden", !text);
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ms-1 font-medium underline underline-offset-2";
      button.textContent = copy.retryText;
      button.addEventListener("click", () => void load(true), { signal: options.signal });
      note.append(" ", button);
    }
  };

  const effectiveFee = (rate: DeliveryRate) => rate.quoted
    ? rate.fee
    : options.isFeeWaived()
      ? 0
      : hasPendingShippingRate(rate)
        ? null
        : rate.freeOver !== null && options.readSubtotal() >= rate.freeOver ? 0 : rate.fee;

  const feeFacts = (rate: DeliveryRate) => {
    // The quote's fee is what the buyer pays: nothing left to explain.
    if (rate.quoted) {
      return { label: rate.fee === 0 ? copy.freeText : options.formatMoney(rate.fee), note: "" };
    }
    if (hasPendingShippingRate(rate)) {
      return { label: options.isFeeWaived() ? copy.freeText : copy.loadingText, note: "" };
    }
    const subtotal = options.readSubtotal();
    if (options.isFeeWaived() && rate.fee > 0) {
      return {
        label: copy.freeText,
        note: formatCheckoutLanguageText(copy.waivedShippingFeeText, { fee: options.formatMoney(rate.fee) }),
      };
    }
    if (rate.fee > 0 && rate.freeOver !== null && subtotal >= rate.freeOver) {
      return { label: copy.freeText, note: "" };
    }
    return {
      label: rate.fee === 0 ? copy.freeText : options.formatMoney(rate.fee),
      note: rate.fee > 0 && rate.freeOver !== null
        ? formatCheckoutLanguageText(copy.freeOverText, { amount: options.formatMoney(rate.freeOver) })
        : "",
    };
  };

  const refreshFees = () => {
    const current = shown();
    for (const option of list.querySelectorAll<HTMLElement>("[data-rate-id]")) {
      const rate = current.find((candidate) => candidate.id === option.dataset.rateId);
      if (!rate) continue;
      const facts = feeFacts(rate);
      const label = option.querySelector<HTMLElement>("[data-fee-label]");
      const feeNote = option.querySelector<HTMLElement>("[data-fee-note]");
      if (label) label.textContent = facts.label;
      if (feeNote) {
        feeNote.textContent = facts.note;
        feeNote.classList.toggle("hidden", !facts.note);
      }
    }
  };

  // Loading and "choose an address" take a delivery option's place at its
  // size, so the options arrive without moving the page.
  const placeholder = (text: string) => {
    const box = document.createElement("p");
    box.className = `${OPTION_HEIGHT} flex items-center rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground`;
    box.textContent = text;
    // The "choose your city and thana" stand-in: hidden while the location
    // message under the fields already says the same (CheckoutShippingMethods).
    if (text === copy.chooseAddressText) box.dataset.chooseAddress = "";
    return box;
  };
  const showSkeleton = () => {
    const count = Math.max(1, list.children.length);
    list.setAttribute("aria-busy", "true");
    list.replaceChildren(...Array.from({ length: count }, () => {
      const bone = document.createElement("div");
      bone.setAttribute("aria-hidden", "true");
      bone.className = `theme-skeleton ${OPTION_HEIGHT} rounded-lg`;
      return bone;
    }));
    setNote(copy.loadingText);
    note.classList.add("sr-only");
  };

  const render = () => {
    list.removeAttribute("aria-busy");
    list.replaceChildren(...shown().map((rate) => {
      const option = document.createElement("label");
      option.dataset.rateId = rate.id;
      option.className = `${OPTION_HEIGHT} flex cursor-pointer gap-3 rounded-lg border border-border bg-background p-3 transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring`;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "shippingLocation";
      input.value = rate.id;
      input.checked = rate.id === selectedId;
      input.className = "mt-0.5 h-4 w-4 shrink-0 accent-primary";
      const body = document.createElement("span");
      body.className = "min-w-0 flex-1";
      const head = document.createElement("span");
      head.className = "flex items-start justify-between gap-2";
      const name = document.createElement("span");
      name.className = "min-w-0 truncate text-sm font-medium leading-snug text-foreground";
      name.textContent = rate.name;
      const fee = document.createElement("span");
      fee.className = "whitespace-nowrap text-sm font-semibold text-foreground";
      fee.dataset.feeLabel = "";
      head.append(name, fee);
      body.append(head);
      const line = (text: string | null, className = "text-muted-foreground") => {
        if (!text) return;
        const element = document.createElement("span");
        element.className = `mt-0.5 block text-sm ${className}`;
        element.textContent = text;
        body.append(element);
      };
      // One line, so every option is the height its loading stand-in holds.
      line(rate.description, "truncate text-muted-foreground");
      if (rate.kind === "pickup" && rate.pickupAddress) {
        line(formatCheckoutLanguageText(copy.pickupFromText, { address: rate.pickupAddress }), "text-foreground");
      }
      if (rate.kind === "pickup" && rate.pickupHours) {
        line(copy.pickupHoursText
          ? formatCheckoutLanguageText(copy.pickupHoursText, { hours: rate.pickupHours })
          : rate.pickupHours);
      }
      const feeNote = document.createElement("span");
      feeNote.className = "mt-0.5 block hidden text-sm text-muted-foreground";
      feeNote.dataset.feeNote = "";
      body.append(feeNote);
      option.append(input, body);
      return option;
    }));
    refreshFees();
  };

  /** Keep the buyer's choice while it applies; otherwise the first rate of the path. */
  const choose = () => {
    const wanted = selectedId ?? preferredId;
    const current = shown();
    selectedId = current.some((rate) => rate.id === wanted)
      ? wanted
      : current.find((rate) => rate.kind === (mode === "pickup" ? "pickup" : "delivery"))?.id ?? null;
  };

  /** Says, next to the options, how the buyer's delivery changed. */
  const showNotice = (message: string) => {
    if (!notice) return;
    notice.textContent = message;
    notice.classList.toggle("hidden", !message);
    // Frame the options, not the fieldset: a fieldset's edge runs through its legend.
    for (const name of ["rounded-lg", "ring-2", "ring-destructive", "ring-offset-2"]) {
      list?.classList.toggle(name, Boolean(message));
    }
    if (message) container.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };

  const selectedRate = () => shown().find((rate) => rate.id === selectedId) ?? null;

  /** What changed between the rate the buyer chose and the rates now offered. */
  const describeChange = (previous: DeliveryRate): string => {
    const money = (rate: DeliveryRate) => feeFacts(rate).label;
    const now = shown().find((rate) => rate.id === previous.id);
    if (now) {
      return effectiveFee(now) === effectiveFee(previous)
        ? ""
        : formatCheckoutLanguageText(copy.feeChangedText, { old: money(previous), new: money(now) });
    }
    const replacement = selectedRate();
    return replacement
      ? effectiveFee(replacement) === effectiveFee(previous)
        ? formatCheckoutLanguageText(copy.replacedSameFeeText, {
            old: previous.name,
            new: replacement.name,
            fee: money(replacement),
          })
        // Say how much delivery went up or down: "Delivery was Free, now ৳80."
        : formatCheckoutLanguageText(copy.replacedText, {
            old: previous.name,
            new: replacement.name,
            oldFee: money(previous),
            newFee: money(replacement),
          })
      : formatCheckoutLanguageText(copy.goneText, { old: previous.name });
  };

  const applyLoaded = (loaded: DeliveryRate[]) => {
    rates = loaded.filter((rate) =>
      !rejected.has(rate.id) && (!hasModeSwitch || rate.kind === "delivery"));
    choose();
    render();
    setNote(shown().some((rate) => rate.kind === "delivery") ? "" : options.readNoDeliveryReason?.() ?? copy.noDeliveryText);
  };

  const load = async (force = false) => {
    const hasAddress = hasDeliveryDestination(address);
    const current = ++sequence;
    renderLegend();
    // The options are being read again: a failure belongs to the earlier read.
    delete container.dataset.ratesFailed;
    if (mode === "none") {
      // Nothing physical: no method, no fee.
      rates = [];
      delete list.dataset.addressKey;
      selectedId = null;
      render();
      setNote("");
      emit();
      return;
    }
    if (mode === "pickup" || !hasAddress) {
      rates = addressFreeRates().filter((rate) => !rejected.has(rate.id));
      delete list.dataset.addressKey;
      const current = shown();
      const keptId = [selectedId, preferredId].find((id) => current.some((rate) => rate.id === id));
      // A single pickup location is simply chosen.
      selectedId = keptId ?? (mode === "pickup" && current.length === 1 ? current[0]!.id : null);
      render();
      setNote("");
      if (mode !== "pickup") list.append(placeholder(options.readNoDeliveryReason?.() ?? copy.chooseAddressText));
      emit();
      return;
    }
    if (!force && list.dataset.addressKey === addressKey(address)) return;
    list.dataset.addressKey = addressKey(address);
    // Nothing is quoted against the previous address's rate while the new
    // ones load; the totals hear once, when they arrive.
    window.lastShippingEventDetail = undefined;
    showSkeleton();
    const loaded = await options.loadRates(address);
    if (current !== sequence) return;
    if (!loaded) {
      rates = addressFreeRates();
      delete list.dataset.addressKey;
      if (!shown().some((rate) => rate.id === selectedId)) selectedId = null;
      render();
      setNote(deliveryRatesFailedText(copy), true);
      container.dataset.ratesFailed = "true";
      // Said even when nothing was chosen before: the form re-checks the options it marked.
      announced = undefined;
      emit();
      return;
    }
    applyLoaded(loaded);
    emit();
  };

  list.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (input?.name !== "shippingLocation") return;
    selectedId = input.value;
    preferredId = input.value;
    showNotice("");
    emit();
  }, { signal: options.signal });

  void load();

  return {
    refreshFees,
    setMode(next) {
      if (next === mode) return Promise.resolve();
      mode = next;
      // A quote's options belong to the path it priced.
      overlay = null;
      showNotice("");
      // The other path's choice no longer applies; a rate chosen earlier on
      // this path comes back through the draft preference.
      if (selectedId && !rates.some((rate) => rate.id === selectedId && rate.kind === (next === "pickup" ? "pickup" : "delivery"))) {
        selectedId = null;
      }
      return load(true);
    },
    setAddress(next) {
      const nextAddress: DeliveryAddress = {
        cityId: next.cityId ?? "",
        zoneId: next.zoneId ?? "",
        areaId: next.areaId ?? "",
        ...(next.countryCode ? { countryCode: next.countryCode } : {}),
        ...(next.adminArea ? { adminArea: next.adminArea } : {}),
        ...(next.postalCode ? { postalCode: next.postalCode } : {}),
      };
      if (
        nextAddress.cityId !== address.cityId
        || nextAddress.zoneId !== address.zoneId
        || (nextAddress.countryCode ?? "") !== (address.countryCode ?? "")
        || (nextAddress.adminArea ?? "") !== (address.adminArea ?? "")
        || (nextAddress.postalCode ?? "") !== (address.postalCode ?? "")
      ) rejected.clear();
      // A quote's options belong to the address it priced.
      if (addressKey(nextAddress) !== addressKey(address)) overlay = null;
      address = nextAddress;
      showNotice("");
      return load();
    },
    async rejectSelected(shippingRates = null) {
      const previous = selectedRate();
      if (shippingRates) {
        // A store app hid it: the options it left are the ones to show (never the refused one).
        overlay = shippingRates.filter((rate) => rate.id !== selectedId);
      } else if (selectedId) {
        rejected.add(selectedId);
      }
      selectedId = null;
      await load(true);
      if (previous) showNotice(describeChange(previous));
    },
    applyQuotedRates(shippingRates) {
      // Nothing to show on this path; or another address's options are
      // loading, so this quote is about the address the buyer left (the new
      // options are quoted, and answered, once they arrive).
      if (mode === "none" || list.getAttribute("aria-busy") === "true") return;
      if (JSON.stringify(shippingRates) === JSON.stringify(overlay)) return;
      overlay = shippingRates;
      choose();
      render();
      if (mode === "delivery") {
        if (hasDeliveryDestination(address)) {
          setNote(shown().some((rate) => rate.kind === "delivery") ? "" : options.readNoDeliveryReason?.() ?? copy.noDeliveryText);
        } else {
          list.append(placeholder(copy.chooseAddressText));
        }
      }
      emit();
    },
    async recheck() {
      // The quote priced the options a store app changed, and placing the
      // order checks that quote: there is no older fee to compare here.
      if (overlay) return false;
      const previous = selectedRate();
      // Pickup rates need no address; the checkout verifies them itself.
      if (mode !== "delivery" || !previous || !hasDeliveryDestination(address)) return false;
      const current = ++sequence;
      const loaded = await options.loadRates(address);
      // Unreadable rates don't block the order: the checkout verifies the rate itself.
      if (!loaded || current !== sequence) return false;
      const now = loaded.find((rate) => rate.id === previous.id);
      if (now && now.fee === previous.fee && now.freeOver === previous.freeOver && now.rateSource === previous.rateSource) return false;
      const priceChanged = !now || effectiveFee(now) !== effectiveFee(previous);
      applyLoaded(loaded);
      emit();
      const change = describeChange(previous);
      showNotice(change);
      return priceChanged;
    },
  };
}
