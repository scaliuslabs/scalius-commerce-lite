// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digitalMessages } from "~/i18n/digital";
import type { Order } from "./types";

const mocks = vi.hoisted(() => ({ canEditOrders: true, reset: vi.fn(), revoke: vi.fn(), resend: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminDigitalEntitlementsByIdReset: mocks.reset,
  postApiV1AdminDigitalEntitlementsByIdRevoke: mocks.revoke,
  postApiV1AdminOrdersByIdDigitalResend: mocks.resend,
}));
vi.mock("~/lib/api", () => ({ apiData: (value: unknown) => Promise.resolve(value) }));
vi.mock("~/lib/api-mutations/orders", () => ({
  invalidateOrder: vi.fn(() => Promise.resolve()),
  orderErrorMessage: (error: Error) => error.message,
}));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canEditOrders: mocks.canEditOrders }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: React.ReactNode; params: { productId: string } }) => <a href={`/admin/products/${params.productId}/edit`}>{children}</a>,
}));

import { DigitalLinesBody } from "./DigitalLinesBody";
import { DigitalLinesCard } from "./DigitalLinesCard";
import { digitalDeliveryOf } from "./digital-lines";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = digitalMessages.en;

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, productId: `p_${id}`, variantId: null, quantity: 1, fulfilledQuantity: 1, fulfillmentType: "digital", price: 500,
  productName: `Product ${id}`, productImage: null, variantLabel: null, ...extra,
});
const orderOf = (items: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id: "ord_1", status: "delivered", paymentStatus: "paid", items, ...extra }) as unknown as Order;

const ebook = item("i1", {
  extras: {
    downloads: [
      { entitlementId: "ent_1", displayName: "Ebook PDF", downloadCount: 3, downloadLimit: 5, expiresAt: null, revoked: false },
      { entitlementId: "ent_2", displayName: "Audio", downloadCount: 7, downloadLimit: null, expiresAt: null, revoked: true },
    ],
  },
});
const software = item("i2", { extras: { licenceKeys: [{ keyId: "key_1", last4: "ABCD" }] } });

describe("digital order lines", () => {
  it("narrows the API's extras and finds paid digital lines that were not handed over", () => {
    const owed = item("i3", { fulfilledQuantity: 0 });
    const physical = item("i4", { fulfillmentType: "ship", fulfilledQuantity: 0 });
    const paid = digitalDeliveryOf(orderOf([ebook, software, owed, physical, item("i5", { extras: { downloads: [{ bogus: true }] } })]));
    expect(paid.accessEnded).toBe(false);
    expect(paid.lines.map((line) => [line.item.id, line.downloads.length, line.keys.length, line.undelivered])).toEqual([
      ["i1", 2, 0, false], ["i2", 0, 1, false], ["i3", 0, 0, true],
    ]);
    // Unpaid orders don't owe anything yet; cancelled ones end access.
    expect(digitalDeliveryOf(orderOf([owed], { paymentStatus: "unpaid" })).lines).toEqual([]);
    const cancelled = digitalDeliveryOf(orderOf([ebook, owed], { status: "cancelled" }));
    expect(cancelled.accessEnded).toBe(true);
    expect(cancelled.lines.map((line) => line.item.id)).toEqual(["i1"]);
  });

  describe("card", () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.canEditOrders = true;
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    });
    afterEach(() => {
      act(() => root.unmount());
      document.body.innerHTML = "";
    });
    const render = (order: Order) => act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <DigitalLinesBody orderId={order.id} delivery={digitalDeliveryOf(order)} />
        </QueryClientProvider>,
      );
    });
    const button = (label: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === label);

    it("renders nothing for an order without digital lines", async () => {
      await act(async () => root.render(<DigitalLinesCard order={orderOf([item("i9", { fulfillmentType: "ship" })])} />));
      expect(host.innerHTML).toBe("");
    });

    it("shows download counts, revoked files and keys by their last 4 only, with the staff actions", async () => {
      await render(orderOf([ebook, software]));
      expect(host.textContent).toContain(en.orderTitle);
      expect(host.textContent).toContain("3 of 5 downloads");
      expect(host.textContent).toContain("7 downloads");
      expect(host.textContent).toContain(en.revoked);
      expect(host.textContent).toContain("•••• ABCD");
      expect(button(en.allowMore)).toBeDefined();
      mocks.reset.mockResolvedValue({ entitlementId: "ent_1", orderId: "ord_1" });
      await act(async () => button(en.allowMore)!.click());
      expect(mocks.reset).toHaveBeenCalledWith({ path: { id: "ent_1" } });
      mocks.resend.mockResolvedValue({ outboxId: "o1", queued: true });
      await act(async () => button(en.resend)!.click());
      expect(mocks.resend).toHaveBeenCalledWith({ path: { id: "ord_1" }, body: { requestKey: expect.any(String) } });
    });

    it("hides actions from staff without order edit access", async () => {
      mocks.canEditOrders = false;
      await render(orderOf([ebook]));
      expect(button(en.resend)).toBeUndefined();
      expect(button(en.allowMore)).toBeUndefined();
      expect(button(en.revokeAccess)).toBeUndefined();
    });

    it("says why a paid line wasn't delivered and links to its product", async () => {
      await render(orderOf([item("i3", { fulfilledQuantity: 0 })]));
      expect(host.textContent).toContain(en.undelivered);
      expect(host.querySelector("a")?.getAttribute("href")).toBe("/admin/products/p_i3/edit");
      // Nothing was delivered, so there is nothing to resend.
      expect(button(en.resend)).toBeUndefined();
    });

    it("marks access as ended on a refunded order and offers no actions", async () => {
      await render(orderOf([ebook, software], { status: "refunded", paymentStatus: "refunded" }));
      expect(host.textContent?.split(en.accessEnded).length).toBe(3);
      expect(button(en.resend)).toBeUndefined();
      expect(button(en.revokeAccess)).toBeUndefined();
    });
  });
});
