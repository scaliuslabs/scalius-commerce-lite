// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { translate } from "~/i18n";
import { formMessages } from "~/i18n/forms";
import { productMessages } from "~/i18n/products";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ useBlocker: () => ({ status: "idle" }) }));
vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (price: number) => `৳${price}`, salePrice: () => null }),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { useFormWithRefusals } from "~/lib/input-refusals";
import { SaveBarProvider, SaveErrorBanner, SaveNotCompleted, useSaveBar } from "../shared/SaveBar";
import { useFieldErrorLines } from "../shared/use-form-save-bar";
import { PricingCard } from "./PricingCard";
import { DEFAULT_PRODUCT_CONDITION, productFormSchema, type ProductFormValues } from "./types";
import { productFieldLabel } from "./utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wholeTaka = translate(formMessages, "wholeTaka");
const notANumber = translate(productMessages, "issueNotANumber");

const validProduct: ProductFormValues = {
  name: "Linen shirt",
  description: "A long enough description of the shirt.",
  price: 100,
  categoryId: "",
  isActive: false,
  discountType: "percentage",
  discountPercentage: 0,
  discountAmount: 0,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  salesChannelIds: null,
  productCondition: DEFAULT_PRODUCT_CONDITION,
  slug: "",
  media: [],
  slugEdited: false,
  variantPriced: false,
  attributes: [],
  additionalInfo: [],
  fulfillmentKind: "physical",
  isGiftCard: false,
  warrantyPolicyId: null,
  brandId: null,
  customizationSchema: [],
};

const saved = vi.fn();

/** The product editor's validation, banner lines and Save, around the real Price field. */
function Page() {
  const form = useFormWithRefusals<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    mode: "onBlur",
    defaultValues: validProduct,
  });
  const invalidLines = useFieldErrorLines(form);
  useSaveBar({
    dirty: form.formState.isDirty,
    save: async () => {
      let fieldLines: string[] = [];
      const values = await new Promise<ProductFormValues | null>((resolve) => {
        void form.handleSubmit(resolve, (errors) => {
          fieldLines = invalidLines(errors, (field) => `${productFieldLabel(field)}: ${String(errors[field]?.message)}`);
          resolve(null);
        })();
      });
      if (!values) throw new SaveNotCompleted(fieldLines[0], fieldLines);
      saved(values);
    },
    discard: () => form.reset(),
  });
  return (
    <Form {...form}>
      <PricingCard form={form} variantPrices={null} />
      <input aria-label="Title" {...form.register("name")} />
    </Form>
  );
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("product price errors in a whole-taka store", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    saved.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(
      <PermissionProvider permissions={[PERMISSIONS.PRODUCTS_VIEW]}>
        <SaveBarProvider><SaveErrorBanner /><Page /></SaveBarProvider>
      </PermissionProvider>,
    ));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const price = () => host.querySelector<HTMLInputElement>("input[name=price]")!;
  const title = () => host.querySelector<HTMLInputElement>("input[aria-label=Title]")!;
  const fieldMessages = () => [...host.querySelectorAll("p.text-destructive")].map((message) => message.textContent);
  const banner = () => [...document.querySelectorAll("[role=alert] li, [role=alert] p")].map((line) => line.textContent);
  const leave = (input: HTMLInputElement) => act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  const typeAmount = (text: string) => act(async () => type(price(), text));
  const save = () => act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("[data-save-bar] button")].find((button) => button.textContent === "Save")!.click();
  });

  it("says the store prices in whole taka for 1234.50, under the field and in the banner", async () => {
    await typeAmount("1234.50");
    expect(price().validationMessage).toBe(wholeTaka);
    await leave(price());
    expect(fieldMessages()).toEqual([wholeTaka]);

    await save();
    expect(saved).not.toHaveBeenCalled();
    expect(fieldMessages()).toEqual([wholeTaka]);
    expect(banner()).toContain(`${productFieldLabel("price")}: ${wholeTaka}`);
    expect(banner().join(" ")).not.toContain(notANumber);
  });

  it("keeps the generic message for text that isn't a number at all", async () => {
    await typeAmount("12a");
    await leave(price());
    expect(fieldMessages()).toEqual([notANumber]);
    await typeAmount("1234.50");
    await leave(price());
    expect(fieldMessages()).toEqual([wholeTaka]);
    await typeAmount("12a");
    await leave(price());
    expect(fieldMessages()).toEqual([notANumber]);
  });

  it("clears the error and its banner line as soon as 1234 is typed", async () => {
    await typeAmount("1234.50");
    await save();
    expect(banner()).toEqual([`${productFieldLabel("price")}: ${wholeTaka}`]);

    await typeAmount("1234");
    expect(fieldMessages()).toEqual([]);
    expect(price().validationMessage).toBe("");
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("takes only the fixed field's line off the banner, and nothing is left after a successful save", async () => {
    await typeAmount("1234.50");
    await act(async () => type(title(), "ab"));
    await save();
    expect(banner().join(" ")).toContain(productFieldLabel("price"));
    expect(banner().join(" ")).toContain(productFieldLabel("name"));

    await typeAmount("1234");
    expect(banner()).toHaveLength(1);
    expect(banner()[0]).toContain(productFieldLabel("name"));
    expect(banner()[0]).not.toContain(productFieldLabel("price"));

    await act(async () => type(title(), "Linen shirt"));
    await save();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0]![0]).toMatchObject({ price: 1234, name: "Linen shirt" });
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(fieldMessages()).toEqual([]);
  });
});
