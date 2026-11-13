import type { LinePropertyInput } from "@scalius/shared/line-properties";
import type { ProductCustomizationField } from "@/lib/api/types";
import { BUYER_INPUT_FIELD_PREFIX } from "../lib/buy-form";
import { loadBuyerUploads } from "@/lib/buyer-uploads/load";
import {
  buyerInputsSurchargeMinor,
  counterText,
  characterCount,
  customizationSchemaFromView,
  validateBuyerInputs,
  type BuyerInputCopy,
  type BuyerInputsValidation,
} from "../lib/buyer-inputs";
import { onTextEdit } from "@/lib/text-edits";

/**
 * The live side of the buyer-inputs form (`ProductBuyerInputs.astro`):
 * character counters, the surcharge for the live price, messages under the
 * fields, and the values for the cart line. Values stay in the page: they
 * are never logged, put in a URL or sent to analytics.
 */
export interface BuyerInputsController {
  form: HTMLFormElement;
  values(): LinePropertyInput[];
  surchargeMinor(): number;
  /** Shows a message under every field that needs one and focuses the first. */
  validate(): BuyerInputsValidation;
}

type FieldControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function readJson<T>(root: ParentNode, id: string): T | null {
  const text = root.querySelector(`#${id}`)?.textContent;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** `form`: the buy form with buyer inputs (ProductBuyerInputs.astro); its fields and their schema are inside it. */
export function initBuyerInputs(form: HTMLFormElement, onChange: () => void): BuyerInputsController | null {
  const fields = readJson<ProductCustomizationField[]>(form, "product-customization-data");
  const copy = readJson<BuyerInputCopy>(form, "product-customization-copy");
  const schema = customizationSchemaFromView({ fields: Array.isArray(fields) ? fields : [] });
  if (!schema || !copy) return null;
  // Our own messages replace the browser's bubbles once the script runs.
  form.noValidate = true;

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

  // An app's input for other SKUs (a disabled fieldset, product-controller.ts) is not this line's.
  const applies = (key: string) => !container(key)?.closest("fieldset")?.disabled;
  const current = () => ({ ...schema, fields: schema.fields.filter((field) => applies(field.key)) });
  const values = (): LinePropertyInput[] =>
    current().fields.map((field) => ({ key: field.key, value: valueOf(field.key) }));

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
    onTextEdit(element, onEdit);
    element.addEventListener("change", onEdit);
    updateCounter(field.key);
  }
  // An app's file input: its upload control (loaded only when the form has one) shows the answer the page filled.
  void loadBuyerUploads(form);

  /** The control the buyer reaches for a field: a file input's picker, else the field itself. */
  const focusable = (key: string): HTMLElement | null =>
    container(key)?.querySelector<HTMLInputElement>("input[type=file][data-buyer-upload-input]") ?? control(key);

  return {
    form,
    values,
    surchargeMinor: () => buyerInputsSurchargeMinor(current(), values()),
    validate() {
      for (const field of schema.fields) showError(field.key, "");
      let result = validateBuyerInputs(current(), values(), copy);
      // A file still uploading: the line waits for it (the picker carries the control's words).
      const sending = result.ok ? form.querySelector<HTMLElement>("[data-buyer-input] [data-buyer-upload][data-buyer-upload-busy]") : null;
      const sendingKey = sending?.closest<HTMLElement>("[data-buyer-input]")?.dataset.buyerInput;
      if (sending && sendingKey) {
        const picker = sending.querySelector<HTMLInputElement>("input[type=file]");
        result = { ok: false, errors: [{ key: sendingKey, message: picker?.validationMessage ?? "" }] };
      }
      if (!result.ok) {
        for (const error of result.errors) showError(error.key, error.message);
        const first = focusable(result.errors[0]!.key);
        if (first) {
          container(result.errors[0]!.key)?.scrollIntoView({ behavior: "smooth", block: "center" });
          first.focus({ preventScroll: true });
        }
      }
      return result;
    },
  };
}
