/**
 * Delivery options on /cart (components/checkout/CheckoutShippingMethods.astro).
 *
 * The options follow the address: every city/zone/area change re-reads the
 * rates offered there (`GET /shipping-methods?cityId&zoneId&areaId`), keeps
 * the buyer's choice while it still applies and otherwise selects the first
 * delivery rate. Pickup is always listed; before an address only pickup is.
 * Other cart code reads the choice from `window.lastShippingEventDetail` and
 * the `shippingLocationChange` event (detail `null` while nothing applies).
 */
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import type { ShippingMethod } from "@/lib/api";

export type DeliveryRate = Pick<ShippingMethod, "id" | "name" | "fee" | "description"> & {
  freeOver: number | null;
  kind: "delivery" | "pickup";
  pickupAddress: string | null;
  pickupHours: string | null;
};

export interface ShippingMethodDetail {
  id: string;
  /** The rate's own charge; see `getEffectiveCartShippingFee` for what the buyer pays. */
  fee: number;
  freeOver: number | null;
  name: string;
  kind: "delivery" | "pickup";
}

export interface DeliveryAddress {
  cityId: string;
  zoneId: string;
  areaId: string;
}

export interface ShippingMethodsCopy {
  freeText: string;
  freeOverText: string;
  waivedShippingFeeText: string;
  pickupFromText: string;
  chooseAddressText: string;
  noDeliveryText: string;
  failedText: string;
  retryText: string;
  loadingText: string;
}

export function toDeliveryRate(method: ShippingMethod): DeliveryRate {
  return {
    id: method.id,
    name: method.name,
    fee: method.fee,
    description: method.description ?? null,
    freeOver: typeof method.freeOver === "number" ? method.freeOver : null,
    kind: method.kind === "pickup" ? "pickup" : "delivery",
    pickupAddress: method.pickupAddress ?? null,
    pickupHours: method.pickupHours ?? null,
  };
}

/** The rates offered for an address, or null when they couldn't be read. */
export async function fetchDeliveryRates(
  apiBaseUrl: string,
  address: DeliveryAddress,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryRate[] | null> {
  const query = new URLSearchParams({ cityId: address.cityId, zoneId: address.zoneId });
  if (address.areaId) query.set("areaId", address.areaId);
  try {
    const response = await fetchImpl(`${apiBaseUrl}/shipping-methods?${query}`, {
      headers: { Accept: "application/json" },
    });
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

const addressKey = (address: DeliveryAddress) =>
  `${address.cityId}|${address.zoneId}|${address.areaId}`;

export function enhanceShippingMethods(
  root: ParentNode,
  options: {
    loadRates: (address: DeliveryAddress) => Promise<DeliveryRate[] | null>;
    readDraftMethod: () => string | undefined;
    /** Items subtotal before discounts, for free-over thresholds. */
    readSubtotal: () => number;
    isFeeWaived: () => boolean;
    formatMoney: (amount: number) => string;
    signal?: AbortSignal;
  },
): {
  refreshFees(): void;
  setAddress(address: Partial<DeliveryAddress>): Promise<void>;
  /** The checkout refused the chosen rate: drop it and re-read the address's rates. */
  rejectSelected(): Promise<void>;
} | null {
  const container = root.querySelector<HTMLElement>("[data-shipping-methods]");
  const list = container?.querySelector<HTMLElement>("[data-shipping-options]");
  const note = container?.querySelector<HTMLElement>("[data-shipping-note]");
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
    retryText: data.retryText || "",
    loadingText: data.loadingText || "",
  };
  let initialRates: DeliveryRate[] = [];
  try {
    const parsed = JSON.parse(container.querySelector("script[data-shipping-rates]")?.textContent || "[]");
    if (Array.isArray(parsed)) initialRates = parsed.map(toDeliveryRate);
  } catch {
    initialRates = [];
  }
  const pickupRates = initialRates.filter((rate) => rate.kind === "pickup");

  let rates: DeliveryRate[] = pickupRates;
  let selectedId: string | null = null;
  let preferredId: string | null = options.readDraftMethod() ?? null;
  let address: DeliveryAddress = { cityId: "", zoneId: "", areaId: "" };
  let sequence = 0;
  const rejected = new Set<string>();

  const emit = () => {
    const rate = rates.find((candidate) => candidate.id === selectedId) ?? null;
    const detail: ShippingMethodDetail | null = rate
      ? { id: rate.id, fee: rate.fee, freeOver: rate.freeOver, name: rate.name, kind: rate.kind }
      : null;
    window.lastShippingEventDetail = detail ?? undefined;
    window.dispatchEvent(new CustomEvent("shippingLocationChange", { detail }));
  };

  const setNote = (text: string, retry = false) => {
    note.textContent = text;
    note.classList.toggle("hidden", !text);
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ml-1 font-medium underline underline-offset-2";
      button.textContent = copy.retryText;
      button.addEventListener("click", () => void load(true), { signal: options.signal });
      note.append(" ", button);
    }
  };

  const feeFacts = (rate: DeliveryRate) => {
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
    for (const option of list.querySelectorAll<HTMLElement>("[data-rate-id]")) {
      const rate = rates.find((candidate) => candidate.id === option.dataset.rateId);
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

  const render = () => {
    list.replaceChildren(...rates.map((rate) => {
      const option = document.createElement("label");
      option.dataset.rateId = rate.id;
      option.className = "flex min-h-11 cursor-pointer gap-3 rounded-lg border border-border bg-background p-3 transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring";
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
      name.className = "text-sm font-medium leading-snug text-foreground";
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
      line(rate.description);
      if (rate.kind === "pickup" && rate.pickupAddress) {
        line(
          [formatCheckoutLanguageText(copy.pickupFromText, { address: rate.pickupAddress }), rate.pickupHours]
            .filter(Boolean).join(" · "),
          "text-foreground",
        );
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

  /** Keep the buyer's choice while it applies; otherwise the first delivery rate. */
  const choose = () => {
    const wanted = selectedId ?? preferredId;
    selectedId = rates.some((rate) => rate.id === wanted)
      ? wanted
      : rates.find((rate) => rate.kind === "delivery")?.id ?? null;
  };

  const load = async (force = false) => {
    const hasAddress = Boolean(address.cityId && address.zoneId);
    const current = ++sequence;
    if (!hasAddress) {
      rates = pickupRates;
      delete list.dataset.addressKey;
      const pickupId = [selectedId, preferredId].find((id) => rates.some((rate) => rate.id === id));
      selectedId = pickupId ?? null;
      render();
      setNote(copy.chooseAddressText);
      emit();
      return;
    }
    if (!force && list.dataset.addressKey === addressKey(address)) return;
    list.dataset.addressKey = addressKey(address);
    // Nothing is quoted against the previous address's rate while the new ones load.
    const keep = selectedId;
    selectedId = null;
    emit();
    selectedId = keep;
    list.setAttribute("aria-busy", "true");
    setNote(copy.loadingText);
    const loaded = await options.loadRates(address);
    if (current !== sequence) return;
    list.removeAttribute("aria-busy");
    if (!loaded) {
      rates = pickupRates;
      delete list.dataset.addressKey;
      if (!rates.some((rate) => rate.id === selectedId)) selectedId = null;
      render();
      setNote(copy.failedText, true);
      emit();
      return;
    }
    rates = loaded.filter((rate) => !rejected.has(rate.id));
    choose();
    render();
    setNote(rates.some((rate) => rate.kind === "delivery") ? "" : copy.noDeliveryText);
    emit();
  };

  list.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (input?.name !== "shippingLocation") return;
    selectedId = input.value;
    preferredId = input.value;
    emit();
  }, { signal: options.signal });

  void load();

  return {
    refreshFees,
    setAddress(next) {
      const nextAddress = {
        cityId: next.cityId ?? "",
        zoneId: next.zoneId ?? "",
        areaId: next.areaId ?? "",
      };
      if (nextAddress.cityId !== address.cityId || nextAddress.zoneId !== address.zoneId) rejected.clear();
      address = nextAddress;
      return load();
    },
    rejectSelected() {
      if (selectedId) rejected.add(selectedId);
      selectedId = null;
      return load(true);
    },
  };
}
