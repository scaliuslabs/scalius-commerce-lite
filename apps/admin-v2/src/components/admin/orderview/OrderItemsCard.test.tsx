// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { Order } from "./types";
import { OrderSummaryCard } from "./OrderItemsCard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className} href="#link">{children}</a>,
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ symbol: "৳", fmt: (value: number) => `৳${value}` }) }));
vi.mock("~/lib/api-query-options/orders", () => ({
  orderReturnsQueryOptions: (id: string) => ({ queryKey: ["returns", id], queryFn: () => new Promise(() => undefined) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

const kurta = {
  id: "i1", productId: "p1", variantId: "v1", quantity: 3, price: 800,
  productName: "Kurta", productImage: null, variantLabel: null,
};
const order = {
  id: "ord_1", items: [kurta], totalAmount: 2255, shippingCharge: 0, discountAmount: 285,
  currencyCode: "BDT", currencyDecimalPlaces: 2, taxLabel: "Tax", pricesIncludeTax: false,
  subtotalAmountMinor: 240_000, shippingAmountMinor: 0, discountAmountMinor: 28_500, taxAmountMinor: 0, totalAmountMinor: 211_500,
  shippingMethodName: "Standard delivery", shippingMethodBaseAmountMinor: 6_000, shippingFeeWaived: true,
  discounts: [{
    promotionId: "promo_1", name: "Amount off order", code: "R2MKTORD15", method: "code", kind: "order",
    amount: 285, shippingAmount: 0,
  }],
} as unknown as Order;

/** ৳2,400 of items, ৳80 delivery made free by FREESHIP and ৳285 off the items by R2MKTORD15. */
const withDeliveryCode = {
  ...order,
  totalAmount: 2115, shippingCharge: 80, discountAmount: 365,
  shippingAmountMinor: 8_000, discountAmountMinor: 36_500, totalAmountMinor: 211_500,
  shippingMethodBaseAmountMinor: 8_000, shippingFeeWaived: false,
  discounts: [
    { promotionId: "promo_1", name: "Amount off order", code: "R2MKTORD15", method: "code", kind: "order", amount: 285, shippingAmount: 0 },
    { promotionId: "promo_2", name: "Free delivery", code: "FREESHIP", method: "code", kind: "shipping", amount: 80, shippingAmount: 80 },
  ],
} as unknown as Order;

/** Reads "৳2,400.00" / "−৳285.00" as a number. */
const amountIn = (text: string) => Number(/−?৳[\d,]+\.\d{2}$/.exec(text)?.[0].replace(/[৳,]/g, "").replace("−", "-") ?? Number.NaN);

describe("OrderSummaryCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    document.body.innerHTML = "";
  });

  async function render(returns: unknown[] = [], shown: Order = order) {
    client.setQueryData(["returns", "ord_1"], { returns });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <OrderSummaryCard order={shown} />
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  const rows = () => [...host.querySelectorAll("dl > div")].map((row) => row.textContent ?? "");

  it("shows each item discount once as Discount · Title (CODE)", async () => {
    await render();
    const discount = rows().find((row) => row.includes("R2MKTORD15"))!;
    expect(discount.match(/R2MKTORD15/g)).toHaveLength(1);
    expect(discount).toMatch(/^Discount · Amount off order \(R2MKTORD15\)−৳285\.00$/);
    expect(host.querySelector("dl a")?.textContent).toBe("Amount off order (R2MKTORD15)");
  });

  it("shows a waived delivery fee as Free with the original fee struck through", async () => {
    await render();
    const delivery = rows().find((row) => row.startsWith("Delivery"))!;
    expect(delivery).toContain(en["delivery.free"]);
    expect(host.querySelector("s")?.textContent).toMatch(/60/);
    expect(delivery).not.toContain(en["delivery.feeWaived"]);
  });

  it("puts delivery savings on the delivery line and still adds up to the total (decision 4)", async () => {
    await render([], withDeliveryCode);
    const summary = rows();
    const delivery = summary.find((row) => row.startsWith("Delivery"))!;
    expect(host.querySelector("s")?.textContent).toBe("৳80.00");
    expect(delivery).toMatch(/৳80\.00 Free \(FREESHIP\)$/);
    // FREESHIP is not a discount line; R2MKTORD15 is.
    expect(summary.filter((row) => row.startsWith(en["summary.discount"]))).toEqual([
      "Discount · Amount off order (R2MKTORD15)−৳285.00",
    ]);
    const subtotal = amountIn(summary.find((row) => row.startsWith(en["summary.subtotal"]))!);
    const discounts = summary.filter((row) => row.startsWith(en["summary.discount"])).map(amountIn);
    const total = amountIn(summary.find((row) => row.startsWith(en["summary.total"]))!);
    expect(subtotal + 0 + discounts.reduce((sum, value) => sum + value, 0)).toBeCloseTo(total, 2);
    expect(total).toBe(2115);
  });

  it("shows a reduced delivery fee with the full fee struck through", async () => {
    await render([], {
      ...withDeliveryCode,
      totalAmount: 2155, discountAmount: 325, discountAmountMinor: 32_500, totalAmountMinor: 215_500,
      discounts: [
        withDeliveryCode.discounts[0]!,
        { promotionId: "promo_3", name: "Half-price delivery", code: null, method: "automatic", kind: "shipping", amount: 40, shippingAmount: 40 },
      ],
    } as unknown as Order);
    const delivery = rows().find((row) => row.startsWith("Delivery"))!;
    expect(delivery).toMatch(/৳80\.00 ৳40\.00 \(Half-price delivery\)$/);
  });
});
