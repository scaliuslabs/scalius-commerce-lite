import type { LinePropertyInput } from "@scalius/shared/line-properties";
import type { ProductCustomizationField } from "@/lib/api/types";
import {
  BUYER_INPUT_FIELD_PREFIX,
  buyerInputsSurchargeMinor,
  counterText,
  characterCount,
  customizationSchemaFromView,
  validateBuyerInputs,
  type BuyerInputCopy,
  type BuyerInputsValidation,
} from "../lib/buyer-inputs";

/**
 * The live side of the buyer-inputs form (`ProductBuyerInputs.astro`):
 * character counters, the surcharge for the live price, messages under the
 * fields, and the values for the cart line. Values stay in the page: they
 * are never logged, put in a URL or sent to analytics.
 */
export interface BuyerInputsController {
  form: HTMLFormElement;
  copy: BuyerInputCopy;
  values(): LinePropertyInput[];
  surchargeMinor(): number;
  /** Shows a message under every field that needs one and focuses the first. */
  validate(): BuyerInputsValidation;
  prefill(values: readonly LinePropertyInput[]): void;
  /** Keeps the form's `variant` field on the chosen SKU (the no-JavaScript POST reads it). */
  setVariant(variantId: string | null): void;
}

type FieldControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function readJson<T>(root: Document, id: string): T | null {
  const text = root.getElementById(id)?.textContent;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function initBuyerInputs(root: Document, onChange: () => void): BuyerInputsController | null {
  const form = root.querySelector<HTMLFormElement>("form[data-buyer-inputs]");
  const fields = readJson<ProductCustomizationField[]>(root, "product-customization-data");
  const copy = readJson<BuyerInputCopy>(root, "product-customization-copy");
  const schema = customizationSchemaFromView({ fields: Array.isArray(fields) ? fields : [] });
  if (!form || !schema || !copy) return null;
  // Our own messages replace the browser's bubbles once the script runs.
  form.noValidate = true;
  const variantInput = form.querySelector<HTMLInputElement>("[data-buyer-inputs-variant]");

  const control = (key: string) =>
    form.elements.namedItem(`${BUYER_INPUT_FIELD_PREFIX}${key}`) as FieldControl | null;
  const container = (key: string) =>
    form.querySelector<HTMLElement>(`[data-buyer-input="${CSS.escape(key)}"]`);

  const valueOf = (key: string): string => {
    const element = control(key);
    if (!element) return "";
    if (element instanceof HTMLInputElement && element.type === "checkbox") {
      return element.checked ? "true" : "";
    }
    return element.value;
  };

  const values = (): LinePropertyInput[] =>
    schema.fields.map((field) => ({ key: field.key, value: valueOf(field.key) }));

  const showError = (key: string, message: string) => {
    const note = container(key)?.querySelector<HTMLElement>("[data-buyer-input-error]");
    const element = control(key);
    if (note) {
      note.textContent = message;
      note.classList.toggle("hidden", !message);
    }
    if (message) element?.setAttribute("aria-invalid", "true");
    else element?.removeAttribute("aria-invalid");
  };

  const updateCounter = (key: string) => {
    const element = control(key);
    const counter = container(key)?.querySelector<HTMLElement>("[data-buyer-input-counter]");
    const max = Number(element?.dataset.buyerInputMax);
    if (!element || !counter || !(max > 0)) return;
    counter.textContent = counterText(copy, element.value, max);
    const over = characterCount(element.value) > max;
    counter.classList.toggle("text-destructive", over);
    counter.classList.toggle("text-muted-foreground", !over);
  };

  for (const field of schema.fields) {
    const element = control(field.key);
    if (!element) continue;
    const onEdit = () => {
      showError(field.key, "");
      updateCounter(field.key);
      onChange();
    };
    element.addEventListener("input", onEdit);
    element.addEventListener("change", onEdit);
    updateCounter(field.key);
  }

  return {
    form,
    copy,
    values,
    surchargeMinor: () => buyerInputsSurchargeMinor(schema, values()),
    validate() {
      for (const field of schema.fields) showError(field.key, "");
      const result = validateBuyerInputs(schema, values(), copy);
      if (!result.ok) {
        for (const error of result.errors) showError(error.key, error.message);
        const first = control(result.errors[0]!.key);
        if (first) {
          container(result.errors[0]!.key)?.scrollIntoView({ behavior: "smooth", block: "center" });
          first.focus({ preventScroll: true });
        }
      }
      return result;
    },
    prefill(entries) {
      const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
      for (const field of schema.fields) {
        const element = control(field.key);
        const value = byKey.get(field.key);
        if (!element || value === undefined) continue;
        if (element instanceof HTMLInputElement && element.type === "checkbox") {
          element.checked = value === "true";
        } else {
          element.value = value;
        }
        updateCounter(field.key);
      }
      onChange();
    },
    setVariant(variantId) {
      if (variantInput) variantInput.value = variantId ?? "";
    },
  };
}
