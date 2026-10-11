// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Form } from "@/components/ui/form";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { StatusCard } from "./StatusCard";
import type { ProductFormValues } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let form: UseFormReturn<ProductFormValues> | null = null;

function Harness({ isActive, storefrontUrl, readOnly = false }: { isActive: boolean; storefrontUrl?: string; readOnly?: boolean }) {
  const hookForm = useForm<ProductFormValues>({
    defaultValues: { isActive, freeDelivery: false, productCondition: "new" } as ProductFormValues,
  });
  form = hookForm;
  return (
    <Form {...hookForm}>
      <StatusCard form={hookForm} storefrontUrl={storefrontUrl} readOnly={readOnly} />
    </Form>
  );
}

describe("StatusCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const statusSelect = () =>
    host.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${translate(productMessages, "status")}"]`);

  it.each([true, false])("shows saved status and condition without editors when read only (active=%s)", async (isActive) => {
    await act(async () => root.render(<Harness readOnly isActive={isActive} storefrontUrl="https://shop.example/products/mug" />));
    expect(host.textContent).toContain(translate(productMessages, isActive ? "statusActive" : "statusDraft"));
    expect(host.textContent).toContain(translate(productMessages, isActive ? "statusActiveHelp" : "statusDraftHelp"));
    expect(host.textContent).toContain(translate(productMessages, "conditionNew"));
    expect(host.querySelector("input, select, [role=combobox]")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://shop.example/products/mug");
    expect(form?.formState.isDirty).toBe(false);
  });

  it("shows Active or Draft for the saved isActive value", async () => {
    await act(async () => root.render(<Harness isActive={false} />));
    expect(statusSelect()?.textContent).toBe(translate(productMessages, "statusDraft"));

    await act(async () => root.render(<Harness key="active" isActive />));
    expect(statusSelect()?.textContent).toBe(translate(productMessages, "statusActive"));
  });

  it("updates the form through the searchable status choices", async () => {
    await act(async () => root.render(<Harness isActive={false} />));
    await act(async () => statusSelect()!.click());
    const active = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent === translate(productMessages, "statusActive"));
    await act(async () => active!.click());
    expect(form?.getValues("isActive")).toBe(true);
    expect(statusSelect()?.textContent).toBe(translate(productMessages, "statusActive"));
    expect(host.querySelector("select")).toBeNull();
  });

  it("links to the storefront only for saved products", async () => {
    await act(async () => root.render(<Harness isActive />));
    expect(host.querySelector("a")).toBeNull();

    await act(async () => root.render(<Harness isActive storefrontUrl="https://shop.example/products/mug" />));
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://shop.example/products/mug");
  });
});
