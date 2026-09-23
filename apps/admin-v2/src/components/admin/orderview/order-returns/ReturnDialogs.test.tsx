// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { OrderReturnDto } from "~/lib/order-return-workflow";
import type { OrderItem } from "../types";
import { ApproveReturnDialog } from "./ApproveReturnDialog";
import { ReceiveReturnDialog } from "./ReceiveReturnDialog";

const mocks = vi.hoisted(() => ({ approve: vi.fn(), receive: vi.fn() }));
vi.mock("~/lib/api-mutations/orders", () => ({
  useApproveOrderReturn: () => ({ mutate: mocks.approve, isPending: false }),
  useReceiveOrderReturn: () => ({ mutate: mocks.receive, isPending: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

const item = {
  id: "item_1", productId: "p1", variantId: "v1", quantity: 3, price: 500,
  productName: "Shirt", productImage: null, variantLabel: "M", fulfillmentStatus: "delivered",
} as OrderItem;
const orderReturn = {
  id: "ret_1", orderId: "ord_1", version: 4, status: "approved", reason: "Wrong size",
  lines: [{
    id: "line_1", orderItemId: "item_1", requestedQuantity: 3, approvedQuantity: 3, receivedQuantity: 0,
    restockQuantity: 0, damagedQuantity: 0, inventoryTracked: true, reason: null,
  }],
  receipts: [],
} as unknown as OrderReturnDto;
const itemsById = new Map([[item.id, item]]);

function setNumber(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("return dialogs", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;

  it("splits every received unit into restocked and damaged", async () => {
    await act(async () => root.render(
      <ReceiveReturnDialog orderReturn={orderReturn} itemsById={itemsById} open onOpenChange={() => undefined} />,
    ));
    const name = "Shirt · M";
    await act(async () => setNumber(input(en["returns.receivedQty"].replace("{name}", name)), "3"));
    await act(async () => setNumber(input(en["returns.restockQty"].replace("{name}", name)), "1"));
    await act(async () => button(en["returns.receiveSummary"].replace("{received}", "3").replace("{restock}", "1").replace("{damaged}", "2")).click());

    const [payload] = mocks.receive.mock.calls[0]!;
    expect(payload.expectedVersion).toBe(4);
    expect(payload.lines).toEqual([{ lineId: "line_1", receivedQuantity: 3, restockQuantity: 1, damagedQuantity: 2 }]);
  });

  it("approves quantities without sending any stock change", async () => {
    const requested = { ...orderReturn, status: "requested" } as OrderReturnDto;
    await act(async () => root.render(
      <ApproveReturnDialog orderReturn={requested} itemsById={itemsById} open onOpenChange={() => undefined} />,
    ));
    await act(async () => setNumber(input(en["returns.approveQty"].replace("{name}", "Shirt · M")), "2"));
    await act(async () => button(en["returns.approveSummary"].replace("{approved}", "2").replace("{rejected}", "1")).click());

    const [payload] = mocks.approve.mock.calls[0]!;
    expect(payload.lines).toEqual([{ lineId: "line_1", approvedQuantity: 2, rejectedQuantity: 1 }]);
    expect(JSON.stringify(payload)).not.toMatch(/restock|damaged|received/i);
  });
});
