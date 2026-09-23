// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Form } from "@/components/ui/form";
import { StatusCard } from "./StatusCard";
import type { ProductFormValues } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const form = useForm<ProductFormValues>({
    defaultValues: { isActive: false, freeDelivery: false, productCondition: "new" } as ProductFormValues,
  });
  return (
    <Form {...form}>
      <StatusCard form={form} />
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

  it("updates the status badge when Published is toggled", async () => {
    await act(async () => root.render(<Harness />));
    expect(host.textContent).toContain("Draft");

    const publishedSwitch = host.querySelector<HTMLButtonElement>('button[role="switch"]');
    await act(async () => publishedSwitch?.click());

    expect(publishedSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Active");
    expect(host.textContent).not.toContain("Draft");
  });
});
