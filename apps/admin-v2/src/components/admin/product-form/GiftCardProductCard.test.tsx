// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { translate } from "~/i18n";
import { giftCardProductMessages } from "~/i18n/gift-card-product";
import { GiftCardProductCard } from "./GiftCardProductCard";
import type { ProductFormValues } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let form: UseFormReturn<ProductFormValues> | null = null;

function Harness({ isGiftCard, readOnly = false }: { isGiftCard: boolean; readOnly?: boolean }) {
  const hookForm = useForm<ProductFormValues>({
    defaultValues: {
      isGiftCard,
      fulfillmentKind: "physical",
      discountType: "percentage",
      discountPercentage: 10,
      discountAmount: 0,
    } as ProductFormValues,
  });
  form = hookForm;
  return <GiftCardProductCard form={hookForm} productId="prod_1" readOnly={readOnly} />;
}

describe("GiftCardProductCard", () => {
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
    form = null;
  });

  const toggle = () => host.querySelector<HTMLButtonElement>('button[role="switch"]');

  it("makes the product a gift card, digital and undiscounted, and explains the rules", async () => {
    await act(async () => root.render(<Harness isGiftCard={false} />));
    expect(host.textContent).not.toContain(translate(giftCardProductMessages, "productRuleNoGiftCardTender"));

    await act(async () => toggle()?.click());

    expect(form?.getValues("isGiftCard")).toBe(true);
    expect(form?.getValues("fulfillmentKind")).toBe("digital");
    expect(form?.getValues("discountPercentage")).toBe(0);
    expect(form?.getFieldState("isGiftCard").isDirty).toBe(true);
    expect(host.textContent).toContain(translate(giftCardProductMessages, "productRuleNoGiftCardTender"));
    expect(host.textContent).toContain(translate(giftCardProductMessages, "productSwitchedOn"));
  });

  it("switches off without touching the rest", async () => {
    await act(async () => root.render(<Harness isGiftCard />));
    await act(async () => toggle()?.click());

    expect(form?.getValues("isGiftCard")).toBe(false);
    expect(form?.getValues("fulfillmentKind")).toBe("physical");
  });

  it("can't be changed read-only", async () => {
    await act(async () => root.render(<Harness isGiftCard={false} readOnly />));
    expect(toggle()?.disabled).toBe(true);
  });
});
