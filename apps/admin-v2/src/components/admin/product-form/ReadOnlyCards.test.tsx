// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";
import { Form } from "@/components/ui/form";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { ShippingCard } from "./ShippingCard";
import { TitleDescriptionSection } from "./TitleDescriptionSection";
import type { ProductFormValues } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ readOnly }: { readOnly: boolean }) {
  const form = useForm<ProductFormValues>({
    defaultValues: { name: "Blue mug", description: null, fulfillmentKind: "physical", freeDelivery: true } as ProductFormValues,
  });
  return (
    <Form {...form}>
      <TitleDescriptionSection form={form} readOnly={readOnly} />
      <ShippingCard form={form} hasOptions={false} readOnly={readOnly} />
    </Form>
  );
}

describe("title and shipping read only", () => {
  let host: HTMLDivElement;
  let root: Root;
  async function render(readOnly: boolean) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness readOnly={readOnly} />));
  }
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows saved title, fulfilment and free delivery as text", async () => {
    await render(true);
    expect(host.textContent).toContain("Blue mug");
    expect(host.textContent).toContain(translate(productMessages, "fulfilmentMode.physical"));
    expect(host.textContent).toContain(translate(productMessages, "freeDeliveryYes"));
    expect(host.querySelectorAll("input, [role=checkbox], [role=combobox]")).toHaveLength(0);
  });

  it("keeps the editors for staff who can edit", async () => {
    await render(false);
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.querySelector("[role=checkbox]")).not.toBeNull();
  });
});
