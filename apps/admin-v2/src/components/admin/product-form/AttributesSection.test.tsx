// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { expect, it, vi } from "vitest";
import { Form } from "~/components/ui/form";
import type { AttributeManager } from "./AttributeManager";
import type { ProductFormValues } from "./types";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./AttributeManager", async () => {
  loaded();
  const { useState } = await import("react");
  return {
    AttributeManager: ({ initialAttributes, onAttributesChange }: ComponentProps<typeof AttributeManager>) => {
      const [value, setValue] = useState(initialAttributes[0]!.value);
      return <input aria-label="Attribute value" value={value} onChange={(event) => {
        setValue(event.target.value);
        onAttributesChange([{ attributeId: "material", value: event.target.value }]);
      }} />;
    },
  };
});
import { AttributesSection } from "./AttributesSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("loads attributes on first open and retains an edited value while the card is closed", async () => {
  let form!: UseFormReturn<ProductFormValues>;
  function Harness() {
    form = useForm<ProductFormValues>({ defaultValues: { attributes: [{ attributeId: "material", value: "Cotton" }] } });
    void form.formState.isDirty;
    return <Form {...form}><AttributesSection form={form} defaultOpen={false} /></Form>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    expect(loaded).not.toHaveBeenCalled();
    expect(host.querySelector("input")).toBeNull();
    expect(form.formState.isDirty).toBe(false);
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => toggle.click());
    expect(loaded).toHaveBeenCalledTimes(1);
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("Cotton");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Linen");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(form.getValues("attributes")).toEqual([{ attributeId: "material", value: "Linen" }]);
    expect(form.formState.isDirty).toBe(true);
    act(() => toggle.click());
    expect(input.closest("[hidden]")).not.toBeNull();
    act(() => toggle.click());
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("Linen");
    expect(loaded).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
