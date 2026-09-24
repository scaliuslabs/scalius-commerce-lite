/**
 * Inline validation for the checkout information form: every problem is shown
 * under its own field at once (with `aria-invalid` and `aria-describedby`),
 * a field is checked when the buyer leaves it with something typed, and each
 * message clears as soon as that field is fixed. Untouched fields are never
 * marked invalid.
 */
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { MIN_SHIPPING_ADDRESS_LENGTH } from "./shipping-address";

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

/** The name, email, address, location and delivery fields of the cart form. */
export function checkoutInformationFields(
  root: ParentNode,
  copy: CheckoutLanguageData,
): CheckoutField[] {
  const fields: CheckoutField[] = [];
  const add = (controlId: string, errorId: string, check: () => string) => {
    const control = root.querySelector<HTMLElement>(`#${controlId}`);
    const error = root.querySelector<HTMLElement>(`#${errorId}`);
    if (control && error) fields.push({ control, error, check });
  };
  add("customerName", "customerName-error", () => {
    const name = value(root, "customerName");
    if (!name) return copy.nameRequiredText;
    return name.length < 3 ? copy.nameTooShortText : "";
  });
  add("customerEmail", "customerEmail-error", () => {
    const email = value(root, "customerEmail");
    return email && !EMAIL.test(email) ? copy.emailInvalidText : "";
  });
  add("shippingAddress", "shippingAddressError", () => {
    const address = value(root, "shippingAddress");
    if (!address) return copy.addressRequiredText;
    return address.length < MIN_SHIPPING_ADDRESS_LENGTH
      ? formatCheckoutLanguageText(copy.addressIncompleteText, { minimum: MIN_SHIPPING_ADDRESS_LENGTH })
      : "";
  });
  // City and zone share one message; the zone is marked only once a city is chosen.
  add("checkout-city", "shippingLocationError", () => value(root, "city") ? "" : copy.cityZoneRequiredText);
  add("checkout-zone", "shippingLocationError", () => {
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
      // Without a city and thana the location message already says what to do.
      check: () =>
        !value(root, "city") || !value(root, "zone")
          || root.querySelector<HTMLInputElement>('[name="shippingLocation"]:checked')?.value
          ? ""
          : copy.deliveryRequiredText,
    });
  }
  return fields;
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
