// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rate = (id: string, name: string, fee: number, kind: "delivery" | "pickup" = "delivery") => ({
  id, name, fee, kind, freeOver: null, description: null, pickupAddress: null, pickupHours: null, isActive: true,
});
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsShippingMethods: async () => ({
    zones: [
      {
        id: "zone_inside",
        name: "Inside Dhaka",
        revision: 1,
        locations: [{ id: "city_dhaka", name: "Dhaka", type: "city", parentName: null }],
        rates: [rate("rate_inside", "Standard delivery", 80)],
      },
      {
        id: "zone_savar",
        name: "Savar",
        revision: 1,
        locations: [{ id: "zone_savar_loc", name: "Savar", type: "zone", parentName: "Dhaka" }],
        rates: [rate("rate_savar", "Suburb delivery", 100)],
      },
    ],
    everywhereElse: { revision: 1, rates: [rate("rate_outside", "Outside Dhaka", 130), rate("rate_pickup", "Pickup", 0, "pickup")] },
  }),
}));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("~/contexts/PermissionContext", () => ({ usePermissions: () => ({ hasPermission: () => true }) }));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", fmt: (n: number) => `৳${n}` }) }));

import { Form } from "~/components/ui/form";
import { orderFormMessages } from "~/i18n/order-form";
import { OrderFormProvider } from "./OrderFormContext";
import { SummarySection } from "./SummarySection";
import type { OrderFormInput, OrderFormValues } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let form: UseFormReturn<OrderFormInput, unknown, OrderFormValues>;

type Edit = { city: string; shippingMethodId: string; shippingCharge: number; saved: { id: string; name: string } };

function Harness({ edit }: { edit?: Edit }) {
  form = useForm<OrderFormInput, unknown, OrderFormValues>({
    defaultValues: {
      city: edit?.city ?? "",
      zone: "",
      area: null,
      items: [],
      shippingCharge: edit?.shippingCharge ?? 0,
      shippingMethodId: edit?.shippingMethodId ?? null,
      discountAmount: null,
    },
  });
  return (
    <Form {...form}>
      <OrderFormProvider
        form={form}
        products={[]}
        isEdit={Boolean(edit)}
        savedShippingMethod={edit?.saved ?? null}
        localTotals={{ subtotal: 0, shipping: 0, discount: 0, total: 0 }}
        manualQuote={{ data: null, isCurrent: false, isLoading: false, discountLimit: null, errorMessage: null, canRetry: false, retry: vi.fn() }}
      >
        <SummarySection />
      </OrderFormProvider>
    </Form>
  );
}

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("create order delivery method", () => {
  let root: Root;

  beforeEach(async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    ));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("picks the delivery method and charge of the zone the chosen city and zone belong to", async () => {
    await act(async () => form.setValue("city", "city_dhaka"));
    await flush();
    expect(form.getValues(["shippingMethodId", "shippingCharge"])).toEqual(["rate_inside", 80]);

    // A zone assigned to its own delivery zone is more specific than its city.
    await act(async () => form.setValue("zone", "zone_savar_loc"));
    await flush();
    expect(form.getValues(["shippingMethodId", "shippingCharge"])).toEqual(["rate_savar", 100]);

    // An address in no zone gets the "Everywhere else" rate, not local pickup.
    await act(async () => {
      form.setValue("zone", "");
      form.setValue("city", "city_khulna");
    });
    await flush();
    expect(form.getValues(["shippingMethodId", "shippingCharge"])).toEqual(["rate_outside", 130]);
  });

  it("keeps a charge the merchant typed when the address changes", async () => {
    await act(async () => form.setValue("city", "city_dhaka"));
    await flush();
    const charge = document.body.querySelector<HTMLInputElement>('input[name="shippingCharge"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(charge, "50");
      charge.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(form.getValues(["shippingMethodId", "shippingCharge"])).toEqual([null, 50]);

    await act(async () => form.setValue("zone", "zone_savar_loc"));
    await flush();
    expect(form.getValues(["shippingMethodId", "shippingCharge"])).toEqual([null, 50]);
  });
});

describe("edit order delivery method", () => {
  let root: Root;

  async function render(edit: Edit) {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness edit={edit} />
      </QueryClientProvider>,
    ));
    await flush();
    return document.body.querySelector<HTMLElement>("#order-delivery-method")!;
  }

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("shows the method the order was placed with, not Custom charge", async () => {
    const picker = await render({
      city: "city_dhaka",
      shippingMethodId: "rate_inside",
      shippingCharge: 80,
      saved: { id: "rate_inside", name: "Standard delivery" },
    });
    expect(picker.textContent).toContain("Inside Dhaka · Standard delivery · ৳80");
    expect(picker.textContent).not.toContain(orderFormMessages.en.customCharge);
    expect(form.getValues(["shippingMethodId", "shippingCharge"])).toEqual(["rate_inside", 80]);
  });

  it("keeps naming a saved method the address no longer offers", async () => {
    const picker = await render({
      city: "city_dhaka",
      shippingMethodId: "rate_ops006",
      shippingCharge: 70,
      saved: { id: "rate_ops006", name: "OPS006 Standard Delivery" },
    });
    expect(picker.textContent).toContain("OPS006 Standard Delivery");
    expect(form.getValues(["shippingMethodId", "shippingCharge"])).toEqual(["rate_ops006", 70]);
  });
});
