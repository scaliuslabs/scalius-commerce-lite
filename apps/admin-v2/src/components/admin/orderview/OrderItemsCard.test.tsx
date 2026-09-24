// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { Order } from "./types";
import { OrderItemsCard } from "./OrderItemsCard";

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
  discounts: [{ promotionId: "promo_1", name: "Amount off order", code: "R2MKTORD15", method: "code", amount: 285 }],
} as unknown as Order;

describe("OrderItemsCard", () => {
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

  async function render(returns: unknown[] = []) {
    client.setQueryData(["returns", "ord_1"], { returns });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <OrderItemsCard order={order} />
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  const rows = () => [...host.querySelectorAll("dl > div")].map((row) => row.textContent ?? "");

  it("shows each discount once: its code as the link, then its title", async () => {
    await render();
    const discount = rows().find((row) => row.includes("R2MKTORD15"))!;
    expect(discount.match(/R2MKTORD15/g)).toHaveLength(1);
    expect(discount).toContain("R2MKTORD15 · Amount off order");
    expect(host.querySelector("dl a")?.textContent).toBe("R2MKTORD15");
  });

  it("shows a waived delivery fee as Free with the original fee struck through", async () => {
    await render();
    const delivery = rows().find((row) => row.startsWith("Delivery"))!;
    expect(delivery).toContain(en["delivery.free"]);
    expect(host.querySelector("s")?.textContent).toMatch(/60/);
    expect(delivery).not.toContain(en["delivery.feeWaived"]);
    expect(rows().some((row) => row.startsWith(en["summary.discount"]))).toBe(false);
  });

  it("says how many of a line came back", async () => {
    await render([
      { lines: [{ orderItemId: "i1", receivedQuantity: 1 }] },
      { lines: [{ orderItemId: "i1", receivedQuantity: 1 }] },
    ]);
    expect(host.textContent).toContain(en["items.returned"].replace("{count}", "2"));
  });
});
