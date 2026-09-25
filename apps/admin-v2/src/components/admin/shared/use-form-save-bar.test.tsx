// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { copyValues, rebaseForm } from "./use-form-save-bar";
import { draftSignature, initialSimpleSku } from "../product-form/variants/option-matrix-editor-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Values = { name: string; revision: number; images: Array<{ id: string; alt: string }> };
const saved: Values = { name: "Shirt", revision: 1, images: [{ id: "a", alt: "Front" }, { id: "b", alt: "Back" }] };

function mountForm() {
  let form!: UseFormReturn<Values>;
  function Probe() {
    form = useForm<Values>({ defaultValues: saved });
    void form.formState.isDirty;
    void form.formState.dirtyFields;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return () => form;
}

describe("form save baseline", () => {
  it("keeps edits typed while a save was in flight dirty, and adopts the server's revision", () => {
    const form = mountForm();
    act(() => form().setValue("name", "Shirt 2", { shouldDirty: true }));
    const sent = copyValues(form().getValues());
    // Typed while the request is on its way.
    act(() => form().setValue("images.1.alt", "Back view", { shouldDirty: true }));
    act(() => rebaseForm(form(), sent, { ...sent, revision: 2 }));
    expect(form().getValues()).toEqual({ ...sent, revision: 2, images: [{ id: "a", alt: "Front" }, { id: "b", alt: "Back view" }] });
    expect(form().formState.isDirty).toBe(true);
    expect(Object.keys(form().formState.dirtyFields)).toEqual(["images"]);
    // Changing it back to what was saved clears the bar.
    act(() => form().setValue("images.1.alt", "Back", { shouldDirty: true }));
    expect(form().formState.isDirty).toBe(false);
  });

  it("discards to exactly the last saved arrays", () => {
    const form = mountForm();
    act(() => form().setValue("images", [{ id: "b", alt: "Back" }], { shouldDirty: true }));
    act(() => form().reset());
    expect(form().getValues()).toEqual(saved);
    expect(form().formState.isDirty).toBe(false);
  });
});

describe("variant draft signature", () => {
  it("is the same after a change is changed back, whatever the key or row order", () => {
    const sku = initialSimpleSku(undefined);
    const options = [{ id: "o1", name: "Size", standardMapping: "size" as const, values: [{ id: "v1", value: "M" }] }];
    const row = { id: "r1", selectedOptionValueIds: ["v1"], imageId: null, sku: "S-M", price: 10, stock: 1, trackInventory: true, weight: null, barcode: null, barcodeType: null, discountType: "percentage" as const, discountPercentage: null, discountAmount: null };
    const other = { ...row, id: "r2" };
    const before = draftSignature(sku, options, [row, other]);
    const { price: _price, ...rest } = row;
    const reverted = { ...rest, price: 10 };
    expect(draftSignature(sku, options, [other, reverted])).toBe(before);
    expect(draftSignature(sku, options, [{ ...row, price: 11 }, other])).not.toBe(before);
  });
});
