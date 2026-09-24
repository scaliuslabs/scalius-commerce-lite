// Checkout phone field controller for the server-rendered markup in
// components/CheckoutPhoneField.astro.
//
// Bangladesh mobile numbers are validated by a tiny fast path; everything
// else (another country, a landline, the country picker) lazy-loads
// ./phone-intl, which runs the same libphonenumber validation the server
// applies. The fast path only accepts numbers libphonenumber also accepts, and
// the server re-validates every order, so the fast path never widens what an
// order can carry. The canonical E.164 value lives in the hidden
// `customerPhone` input (also exposed as `data-e164-value`); it stays empty
// until the visible number validates.
import type { PhoneCountryPolicy } from "@scalius/shared/customer-utils";
import { compactPhone } from "@scalius/shared/phone-input";
import {
  readCheckoutFormDraft,
  syncCheckoutTransferSession,
  writeCheckoutFormDraft,
} from "./session-state";

export interface CheckoutPhoneResult {
  ok: boolean;
  /** Canonical E.164 value; empty unless `ok`. */
  value: string;
  message?: "required" | "invalid" | "country";
  /** Only the lazily loaded international validator can decide. */
  pending?: boolean;
}

type PhoneIntl = typeof import("./phone-intl");

// 01XXXXXXXXX, +8801XXXXXXXXX, 8801XXXXXXXXX, or 1XXXXXXXXX after separators are removed.
const BD_MOBILE = /^(?:\+?880|0)?(1[3-9]\d{8})$/;
// Every partial spelling that can still grow into BD_MOBILE. Typing one never
// loads the international validator.
const BD_MOBILE_PREFIX =
  /^(?:\+(?:8(?:8(?:0(?:1(?:[3-9]\d{0,8})?)?)?)?)?|8(?:8(?:0(?:1(?:[3-9]\d{0,8})?)?)?)?|0(?:1(?:[3-9]\d{0,8})?)?|1(?:[3-9]\d{0,8})?)$/;

export function normalizePhonePolicy(
  policy: PhoneCountryPolicy | undefined,
): Required<PhoneCountryPolicy> {
  const countries = [
    ...new Set(
      (policy?.countries ?? [])
        .map((country) => country.trim().toUpperCase())
        .filter((country) => /^[A-Z]{2}$/.test(country)),
    ),
  ];
  return { countries, mode: policy?.mode === "exclude" ? "exclude" : "include" };
}

export function phoneCountryAllowed(
  country: string,
  policy: Required<PhoneCountryPolicy>,
): boolean {
  if (policy.countries.length === 0) return true;
  const listed = policy.countries.includes(country);
  return policy.mode === "exclude" ? !listed : listed;
}

/**
 * The Bangladesh-mobile fast path. Returns null when only the international
 * validator can decide (another country, a landline, an incomplete number).
 */
export function quickValidatePhone(
  raw: string,
  policy: Required<PhoneCountryPolicy>,
  country: string,
): CheckoutPhoneResult | null {
  const compact = compactPhone(raw);
  if (!compact) return { ok: false, value: "", message: "required" };
  const bangladesh = compact.startsWith("+")
    ? compact.startsWith("+880")
    : country === "BD";
  const match = bangladesh ? BD_MOBILE.exec(compact) : null;
  if (!match) return null;
  return phoneCountryAllowed("BD", policy)
    ? { ok: true, value: `+880${match[1]}` }
    : { ok: false, value: "", message: "country" };
}

/** Shows a canonical E.164 value the way a buyer in that country types it. */
function displayPhone(e164: string, country: string): string {
  return country === "BD" && e164.startsWith("+880") ? `0${e164.slice(4)}` : e164;
}

let intlModule: PhoneIntl | null = null;
let intlLoad: Promise<PhoneIntl | null> | null = null;
let intlFailed = false;

function loadIntl(): Promise<PhoneIntl | null> {
  intlLoad ??= import("./phone-intl")
    .then((module) => {
      intlModule = module;
      intlFailed = false;
      return module;
    })
    .catch(() => {
      // Fail closed for this attempt; a later blur or submit retries.
      intlFailed = true;
      intlLoad = null;
      return null;
    });
  return intlLoad;
}

let activeResult: (() => CheckoutPhoneResult) | null = null;

/** The current validation result of the checkout phone field. */
export function checkoutPhoneResult(): CheckoutPhoneResult {
  return activeResult?.() ?? { ok: false, value: "", message: "required" };
}

/** Loads the international validator so `checkoutPhoneResult` can decide. */
export async function loadCheckoutPhoneValidator(): Promise<void> {
  await loadIntl();
}

/** Wires the server-rendered phone field. Safe to call once per page run. */
export function initCheckoutPhoneField(signal?: AbortSignal): void {
  const root = document.getElementById("customerPhone-field");
  const input = document.getElementById("customerPhone-input") as HTMLInputElement | null;
  const canonical = root?.querySelector<HTMLInputElement>('input[name="customerPhone"]');
  const errorEl = document.getElementById("customerPhone-error");
  if (!root || !input || !canonical) return;

  const data = root.dataset;
  const policy = normalizePhonePolicy({
    countries: (data.countries ?? "").split(","),
    mode: data.countryMode === "exclude" ? "exclude" : "include",
  });
  const messages = {
    required: data.requiredMessage || "Enter your phone number.",
    invalid: data.invalidMessage || "Enter a valid phone number.",
    country:
      data.countryMessage ||
      "This store does not accept phone numbers from that country.",
  };
  let country = data.defaultCountry || "BD";
  let buyerHasEdited = false;

  const result = (): CheckoutPhoneResult => {
    const quick = quickValidatePhone(input.value, policy, country);
    if (quick) return quick;
    if (intlModule) return intlModule.validateInternationalPhone(input.value, policy, country);
    return intlFailed
      ? { ok: false, value: "", message: "invalid" }
      : { ok: false, value: "", pending: true };
  };

  const setError = (message: string) => {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.toggle("hidden", !message);
    }
    root.querySelector("[data-phone-box]")?.classList.toggle("border-destructive", Boolean(message));
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };

  const syncCanonical = () => {
    const current = result();
    const value = current.ok ? current.value : "";
    canonical.value = value;
    canonical.dataset.e164Value = value;
    return current;
  };

  const persist = (value: string) => {
    writeCheckoutFormDraft({ ...(readCheckoutFormDraft() ?? {}), customerPhone: value });
    syncCheckoutTransferSession({ customerPhone: value });
  };

  // Resolves numbers the fast path cannot decide once the validator arrives.
  const syncWhenIntlLoads = (onReady?: () => void) => {
    if (!result().pending) return;
    void loadIntl().then(() => {
      if (signal?.aborted) return;
      syncCanonical();
      onReady?.();
    });
  };

  // Shows a prefilled or saved phone only when it validates for this store.
  const applyValue = (phone: string | undefined) => {
    const value = phone?.trim() ?? "";
    input.value = value ? displayPhone(value, country) : "";
    const settle = () => {
      if (!result().ok) input.value = "";
      syncCanonical();
    };
    if (syncCanonical().pending) syncWhenIntlLoads(settle);
    else settle();
  };

  const validate = () => {
    const current = syncCanonical();
    if (current.pending) {
      syncWhenIntlLoads(validate);
      return;
    }
    // An empty, untouched field stays quiet until the buyer submits.
    if (!input.value.trim() && current.message === "required") {
      setError("");
      return;
    }
    setError(current.ok ? "" : messages[current.message ?? "invalid"]);
    if (current.ok) {
      // Bangla digits, spaces and +880 become the familiar 01XXXXXXXXX.
      input.value = displayPhone(current.value, country);
      persist(current.value);
    }
  };

  const draft = readCheckoutFormDraft();
  if (input.value) {
    // The buyer typed before this script ran; that beats any saved draft.
    buyerHasEdited = true;
    persist(syncCanonical().value);
    syncWhenIntlLoads(() => persist(canonical.value));
  } else if (draft && Object.prototype.hasOwnProperty.call(draft, "customerPhone")) {
    applyValue(draft.customerPhone);
  }

  input.addEventListener(
    "input",
    () => {
      buyerHasEdited = true;
      setError("");
      const current = syncCanonical();
      persist(current.ok ? current.value : "");
      const compact = compactPhone(input.value);
      if (current.pending && !(country === "BD" && BD_MOBILE_PREFIX.test(compact))) {
        syncWhenIntlLoads(() => persist(canonical.value));
      }
    },
    { signal },
  );
  input.addEventListener("blur", validate, { signal });

  window.addEventListener(
    "phone-prefill",
    (event) => {
      if (buyerHasEdited) return;
      const saved = readCheckoutFormDraft();
      const draftOwnsPhone = Boolean(
        saved && Object.prototype.hasOwnProperty.call(saved, "customerPhone"),
      );
      applyValue(draftOwnsPhone ? saved?.customerPhone : (event as CustomEvent<string>).detail);
    },
    { signal },
  );

  window.addEventListener(
    "phone-validation-error",
    (event) => {
      const detail = (event as CustomEvent<{ name?: string; message?: string; focus?: boolean }>).detail;
      if (detail?.name !== "customerPhone") return;
      setError(detail.message || messages.invalid);
      if (detail.focus !== false) requestAnimationFrame(() => input.focus());
    },
    { signal },
  );

  const button = root.querySelector<HTMLButtonElement>("[data-phone-country]");
  button?.addEventListener(
    "click",
    async () => {
      const intl = await loadIntl();
      if (!intl || signal?.aborted || root.querySelector("[data-phone-country-select]")) return;
      const select = intl.createCountrySelect({
        policy,
        selected: country,
        label: data.countryLabel || "Phone number country",
        languageCode: data.language || "en",
      });
      select.addEventListener(
        "change",
        () => {
          country = select.value;
          const code = button.querySelector("[data-phone-code]");
          if (code) code.textContent = intl.callingCode(country);
          buyerHasEdited = true;
          const current = syncCanonical();
          persist(current.ok ? current.value : "");
          input.focus();
        },
        { signal },
      );
      button.tabIndex = -1;
      button.setAttribute("aria-hidden", "true");
      button.after(select);
      select.focus();
      try {
        select.showPicker();
      } catch {
        // Focus alone is the fallback where showPicker is unsupported.
      }
    },
    { signal },
  );

  activeResult = result;
  signal?.addEventListener("abort", () => {
    if (activeResult === result) activeResult = null;
  });
}
