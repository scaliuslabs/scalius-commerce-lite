/**
 * Inline validation for the checkout information form: every problem is shown
 * under its own field at once (with `aria-invalid` and `aria-describedby`),
 * a field is checked when the buyer leaves it with something typed, and each
 * message clears as soon as that field is fixed. Untouched fields are never
 * marked invalid.
 */
import { toLatinDigits } from "@scalius/shared/phone-input";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { MIN_SHIPPING_ADDRESS_LENGTH } from "./shipping-address";
import {
  isCheckoutFieldRequired,
  type CheckoutDeliveryMode,
  type CheckoutRequiredField,
} from "./delivery-mode";
import { LOCATION_COUNTRY, isLocationCountry } from "./shipping-country";
import type { AddressRules } from "@scalius/shared/address";
import type { BillingAddressField } from "./billing-address";
import { billingAddressAsked, billingAddressProblems, billingProblemMessage } from "./billing-validation";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface CheckoutField {
  /** Element that receives focus and `aria-invalid`. */
  control: HTMLElement;
  /** Element the message is written into. */
  error: HTMLElement;
  /** The buyer-facing problem, or "" when the value is acceptable. */
  check(): string;
}

function value(root: ParentNode, name: string): string {
  return root.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? "";
}

export function setFieldError(field: Pick<CheckoutField, "control" | "error">, message: string): void {
  field.error.textContent = message;
  field.error.classList.toggle("hidden", !message);
  if (message) {
    field.control.setAttribute("aria-invalid", "true");
    const described = new Set((field.control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    described.add(field.error.id);
    field.control.setAttribute("aria-describedby", [...described].join(" "));
  } else {
    field.control.removeAttribute("aria-invalid");
  }
}

/**
 * The name, email, address, location and delivery fields of the cart form.
 * Which of them apply follows the checkout path (`CHECKOUT_REQUIRED_FIELDS`):
 * delivery asks for everything, pickup for a pickup location, and a cart
 * with nothing to deliver for contact details only. The phone field checks
 * itself (it is required on every path).
 */
export function checkoutInformationFields(
  root: ParentNode,
  copy: CheckoutLanguageData,
  readMode: () => CheckoutDeliveryMode = () => "delivery",
  /** The billing country's rules once loaded (`enhanceBillingAddress`). */
  readBillingRules: () => AddressRules | null = () => null,
): CheckoutField[] {
  const fields: CheckoutField[] = [];
  const add = (controlId: string, errorId: string, check: () => string) => {
    const control = root.querySelector<HTMLElement>(`#${controlId}`);
    const error = root.querySelector<HTMLElement>(`#${errorId}`);
    if (control && error) fields.push({ control, error, check });
  };
  // Bangladesh by default; a store selling to several countries posts the chosen one.
  const country = () => value(root, "shippingCountryCode") || LOCATION_COUNTRY;
  const required = (field: CheckoutRequiredField) => isCheckoutFieldRequired(readMode(), field, country());
  add("customerName", "customerName-error", () => {
    const name = value(root, "customerName");
    if (!name) return copy.nameRequiredText;
    return name.length < 3 ? copy.nameTooShortText : "";
  });
  // Customer accounts decides whether email is asked and required (the field's `required`).
  add("customerEmail", "customerEmail-error", () => {
    const email = value(root, "customerEmail");
    if (!email) return root.querySelector("#customerEmail[required]") ? copy.emailRequiredText : "";
    return EMAIL.test(email) ? "" : copy.emailInvalidText;
  });
  add("customerWhatsapp", "customerWhatsapp-error", () => {
    const digits = toLatinDigits(value(root, "customerWhatsapp")).replace(/\D/g, "");
    return digits && (digits.length < 10 || digits.length > 15) ? copy.whatsappInvalidText : "";
  });
  add("shippingAddress", "shippingAddressError", () => {
    if (!required("shippingAddress")) return "";
    const address = value(root, "shippingAddress");
    if (!address) return copy.addressRequiredText;
    // Bangladesh's line keeps its minimum; another country's rules are checked by the API.
    return isLocationCountry(country()) && address.length < MIN_SHIPPING_ADDRESS_LENGTH
      ? formatCheckoutLanguageText(copy.addressIncompleteText, { minimum: MIN_SHIPPING_ADDRESS_LENGTH })
      : "";
  });
  // City and zone share one message; the zone is marked only once a city is chosen.
  add("checkout-city", "shippingLocationError", () =>
    !required("city") || value(root, "city") ? "" : copy.cityZoneRequiredText);
  add("checkout-zone", "shippingLocationError", () => {
    if (!required("zone")) return "";
    if (!value(root, "city")) return copy.cityZoneRequiredText;
    return value(root, "zone") ? "" : copy.zoneRequiredText;
  });
  // The delivery options are re-rendered for each address, so the field is their fieldset.
  const methods = root.querySelector<HTMLElement>("#shippingMethods");
  const methodError = root.querySelector<HTMLElement>("#shippingMethodError");
  if (methods && methodError) {
    fields.push({
      control: methods,
      error: methodError,
      check: () => {
        const mode = readMode();
        if (!required("shippingMethod")) return "";
        // The options couldn't be read: their note says so and offers to try again
        // (the buyer has nothing to choose yet, so nothing is their mistake).
        if (methods.closest<HTMLElement>("[data-shipping-methods]")?.dataset.ratesFailed === "true") return "";
        if (root.querySelector<HTMLInputElement>('[name="shippingLocation"]:checked')?.value) return "";
        if (mode === "pickup") return copy.pickupLocationRequiredText;
        // Another country: its shipping zone's options, or none (the options say why).
        if (!isLocationCountry(country())) {
          return methods.querySelector('[name="shippingLocation"]')
            ? copy.deliveryRequiredText
            : copy.noDeliveryToAddressText;
        }
        // Without a city and thana the location message already says what to do.
        return !value(root, "city") || !value(root, "zone") ? "" : copy.deliveryRequiredText;
      },
    });
  }
  fields.push(...billingFields(root, copy, readMode, readBillingRules));
  return fields;
}

/**
 * The billing address fields, when checkout asks for one (billing-
 * validation.ts): each checked by the billing country's rules once they
 * are loaded; before that the API checks them when the order is placed.
 */
function billingFields(
  root: ParentNode,
  copy: CheckoutLanguageData,
  readMode: () => CheckoutDeliveryMode,
  readRules: () => AddressRules | null,
): CheckoutField[] {
  const section = root.querySelector<HTMLElement>("[data-billing-section]");
  if (!section) return [];
  const inputs = [...section.querySelectorAll<HTMLInputElement>("input[data-billing-field]")];
  const problems = () => {
    const asked = billingAddressAsked({
      path: readMode(),
      requireFullBillingAddress: section.dataset.billingFull === "true",
      sameAsShipping: section.querySelector<HTMLInputElement>("[data-billing-same]")?.checked === true,
    });
    const rules = readRules();
    if (!asked.asked || !rules) return [];
    const values = Object.fromEntries(inputs.map((input) => [input.name, input.value]));
    return billingAddressProblems(rules, asked.mode, values);
  };
  return inputs.flatMap((input) => {
    const error = root.querySelector<HTMLElement>(`#${input.id}-error`);
    if (!error) return [];
    const field = input.dataset.billingField as BillingAddressField;
    const label = () => root.querySelector(`label[for="${input.id}"]`)?.firstChild?.textContent?.trim() ?? "";
    return [{
      control: input,
      error,
      check: () => {
        if (input.closest<HTMLElement>("[data-address-rule]")?.hidden) return "";
        const problem = problems().find((entry) => entry.field === field)?.problem;
        return problem ? billingProblemMessage(field, problem, label(), copy) : "";
      },
    }];
  });
}

/**
 * Wires blur and correction handling. Returns `validateAll`, which marks every
 * invalid field and returns the first invalid control (or null).
 */
export function enhanceCheckoutFields(
  fields: CheckoutField[],
  signal?: AbortSignal,
): {
  validateAll(): HTMLElement | null;
  /** Checks typed fields that arrived without a blur (a restored draft), leaving empty ones quiet. */
  checkFilled(): void;
  /** Checks again only the fields already marked (e.g. the delivery options were read again). */
  recheckMarked(): void;
} {
  for (const field of fields) {
    const listenTo = field.control.matches("fieldset")
      ? field.control
      : field.control.closest("[data-location-fields]") ?? field.control;
    // Leaving a field with something typed checks it; an empty untouched field stays quiet.
    field.control.addEventListener("blur", () => {
      const current = field.control as HTMLInputElement;
      if ("value" in current && current.value.trim()) setFieldError(field, field.check());
    }, { signal });
    // Once flagged, a field clears the moment it is fixed.
    const recheck = () => {
      if (field.control.getAttribute("aria-invalid") === "true") setFieldError(field, field.check());
    };
    listenTo.addEventListener("input", recheck, { signal });
    listenTo.addEventListener("change", recheck, { signal });
  }
  return {
    checkFilled() {
      for (const field of fields) {
        const control = field.control;
        const typed = (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && control.value.trim();
        if (typed) setFieldError(field, field.check());
      }
    },
    recheckMarked() {
      for (const field of fields) {
        if (field.control.getAttribute("aria-invalid") === "true") setFieldError(field, field.check());
      }
    },
    validateAll() {
      let first: HTMLElement | null = null;
      for (const field of fields) {
        const message = field.check();
        setFieldError(field, message);
        if (message && !first) first = field.control;
      }
      return first;
    },
  };
}
