// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productMessages } from "~/i18n/products";
import { BuyerInputsCard } from "./BuyerInputsCard";
import {
  buyerInputIssue,
  customizationInput,
  draftsFromView,
  keyFromLabel,
  withKeys,
  type BuyerInputDraft,
} from "./buyer-inputs";
import { formatFormValuesForSubmission, productFieldLabel } from "./utils";
import type { ProductFormValues } from "./types";

vi.mock("@/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", fmt: (n: number) => `৳${n}` }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = productMessages.en;

const text = (key: string, label: string, extra: Partial<BuyerInputDraft> = {}): BuyerInputDraft => ({
  key, label, type: "text", required: false, help: "", maxLength: null, price: null, options: [], ...extra,
});

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let form: UseFormReturn<ProductFormValues>;
function Harness({ initial, conflict }: { initial: BuyerInputDraft[]; conflict?: { onReview: () => void } | null }) {
  form = useForm<ProductFormValues>({ defaultValues: { customizationSchema: initial, fulfillmentKind: "physical" } as ProductFormValues });
  // Subscribe to dirtiness, as the product page does.
  void form.formState.isDirty;
  return <BuyerInputsCard form={form} conflict={conflict ?? null} />;
}

describe("BuyerInputsCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const render = (initial: BuyerInputDraft[], conflict?: { onReview: () => void }) =>
    act(async () => root.render(<Harness initial={initial} conflict={conflict} />));
  const button = (label: string) => [...document.querySelectorAll("button")].find((element) =>
    element.textContent === label || element.getAttribute("aria-label") === label);

  it("adds an input from the dialog, with a key made from its label, and previews it", async () => {
    await render([]);
    expect(host.textContent).toContain(en.buyerInputsEmpty);
    await act(async () => button(en.addBuyerInput)!.click());
    const label = document.querySelector<HTMLInputElement>("#buyer-input-label")!;
    await act(async () => setValue(label, "Engraving text"));
    await act(async () => setValue(document.querySelector<HTMLInputElement>("#buyer-input-price")!, "200"));
    await act(async () => button(en.inputDone)!.click());

    expect(form.getValues("customizationSchema")).toEqual([
      expect.objectContaining({ key: "engraving_text", label: "Engraving text", type: "text", price: 200 }),
    ]);
    expect(form.formState.isDirty).toBe(true);
    expect(host.textContent).toContain(en.buyerInputsPreview);
    expect(host.querySelector('[id="line-property-engraving_text"]')).not.toBeNull();
    expect(host.textContent).toContain("+৳200");
  });

  it("refuses an input without a label or a choice list without choices", async () => {
    await render([]);
    await act(async () => button(en.addBuyerInput)!.click());
    await act(async () => button(en.inputDone)!.click());
    expect(document.body.textContent).toContain(en.inputLabelRequired);
    expect(form.getValues("customizationSchema")).toEqual([]);

    await act(async () => setValue(document.querySelector<HTMLInputElement>("#buyer-input-label")!, "Fit"));
    const type = document.querySelector<HTMLSelectElement>("#buyer-input-type")!;
    await act(async () => {
      type.value = "select";
      type.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(en.inputDone)!.click());
    expect(document.body.textContent).toContain(en.inputChoiceRequired);
  });

  it("stops at ten inputs", async () => {
    await render(Array.from({ length: 10 }, (_, index) => text(`input_${index}`, `Input ${index}`)));
    expect(button(en.addBuyerInput)?.disabled).toBe(true);
    expect(host.textContent).toContain(en.buyerInputsFull.replace("{max}", "10"));
  });

  it("reorders with the arrow buttons, keeping each key", async () => {
    await render([text("engraving", "Engraving"), text("note", "Note")]);
    expect(button(en.moveInputUp.replace("{name}", "Engraving"))?.disabled).toBe(true);
    await act(async () => button(en.moveInputDown.replace("{name}", "Engraving"))!.click());
    expect(form.getValues("customizationSchema").map((draft) => draft.key)).toEqual(["note", "engraving"]);
    expect(form.formState.isDirty).toBe(true);
  });

  it("removes an input", async () => {
    await render([text("engraving", "Engraving"), text("note", "Note")]);
    await act(async () => button(en.removeInput.replace("{name}", "Note"))!.click());
    expect(form.getValues("customizationSchema").map((draft) => draft.key)).toEqual(["engraving"]);
  });

  it("surfaces a revision conflict on the card and opens the review", async () => {
    const onReview = vi.fn();
    await render([text("engraving", "Engraving")], { onReview });
    expect(host.textContent).toContain(en.buyerInputsConflict);
    await act(async () => button(en.reviewConflict)!.click());
    expect(onReview).toHaveBeenCalledTimes(1);
    // The conflict dialog names the changed field in the merchant's words.
    expect(productFieldLabel("customizationSchema")).toBe(en.buyerInputs);
    expect(productFieldLabel("fulfillmentKind")).toBe(en.fulfilment);
  });
});

describe("buyer input rules", () => {
  it("keeps the server's limits", () => {
    expect(buyerInputIssue(text("a", "x".repeat(61)))).toEqual({ field: "label", reason: "tooLong" });
    expect(buyerInputIssue(text("a", "Note", { help: "h".repeat(201) }))).toEqual({ field: "help", reason: "tooLong" });
    expect(buyerInputIssue(text("a", "Note", { maxLength: 201 }))).toEqual({ field: "maxLength", reason: "range" });
    expect(buyerInputIssue(text("a", "Note", { type: "textarea", maxLength: 1000 }))).toBeNull();
    expect(buyerInputIssue(text("a", "Note", { price: -1 }))).toEqual({ field: "price", reason: "negative" });
    const choices = (count: number) => Array.from({ length: count }, (_, index) => ({ value: "", label: `Choice ${index}`, price: null }));
    expect(buyerInputIssue(text("a", "Fit", { type: "select", options: choices(21) }))).toEqual({ field: "options", reason: "tooMany" });
    expect(buyerInputIssue(text("a", "Fit", { type: "select", options: [...choices(1), ...choices(1)] })))
      .toEqual({ field: "option", index: 1, reason: "duplicate" });
  });

  it("makes unique keys, Bangla labels read aloud, and never changes a saved key", () => {
    expect(keyFromLabel("Engraving text", new Set())).toBe("engraving_text");
    expect(keyFromLabel("Engraving text", new Set(["engraving_text"]))).toBe("engraving_text_2");
    expect(keyFromLabel("নাম", new Set())).toMatch(/^[a-z0-9_]{1,40}$/);
    const saved = withKeys(text("engraving", "Name to engrave"), []);
    expect(saved.key).toBe("engraving");
  });

  it("sends each type's own fields and keeps saved choice values", () => {
    const fit = withKeys(text("", "Fit", {
      type: "select",
      options: [{ value: "regular", label: "Regular", price: null }, { value: "", label: "Slim", price: 100 }],
    }), []);
    expect(customizationInput([fit, text("wrap", "Gift wrap", { type: "checkbox", price: 50 })])).toEqual({
      fields: [
        {
          key: "fit", label: "Fit", type: "select", required: false, help: null,
          options: [{ value: "regular", label: "Regular", price: 0 }, { value: "slim", label: "Slim", price: 100 }],
        },
        { key: "wrap", label: "Gift wrap", type: "checkbox", required: false, help: null, price: 50 },
      ],
    });
    expect(customizationInput([])).toBeNull();
  });

  it("reads the saved inputs back into the editor", () => {
    expect(draftsFromView({
      fields: [{ key: "note", label: "Note", type: "textarea", required: true, help: null, maxLength: 500, price: 0, options: [] }],
    })).toEqual([text("note", "Note", { type: "textarea", required: true, maxLength: 500 })]);
  });

  it("puts only changed buyer inputs and a single product kind in an edit", () => {
    const values = { customizationSchema: [text("note", "Note")], fulfillmentKind: "service" } as unknown as ProductFormValues;
    const base = { ...values, media: [], name: "", description: null, price: 0, categoryId: "", isActive: false, discountType: "percentage" } as unknown as ProductFormValues;
    expect(formatFormValuesForSubmission(base, { customizationSchema: false, fulfillmentKind: false })).not.toHaveProperty("customizationSchema");
    expect(formatFormValuesForSubmission(base, { customizationSchema: true, fulfillmentKind: true })).toMatchObject({
      fulfillmentKind: "service",
      customizationSchema: { fields: [expect.objectContaining({ key: "note" })] },
    });
    expect(formatFormValuesForSubmission({ ...base, fulfillmentKind: "mixed" }, { fulfillmentKind: true })).not.toHaveProperty("fulfillmentKind");
  });
});
