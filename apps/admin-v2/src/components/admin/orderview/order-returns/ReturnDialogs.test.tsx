// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { OrderReturnDto } from "~/lib/order-return-workflow";
import type { Order, OrderItem } from "../types";
import { ApproveReturnDialog } from "./ApproveReturnDialog";
import { CreateReturnDialog } from "./CreateReturnDialog";
import { ReceiveReturnDialog } from "./ReceiveReturnDialog";

const mocks = vi.hoisted(() => ({ approve: vi.fn(), receive: vi.fn(), create: vi.fn() }));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useCreateOrderReturn: () => ({ mutate: mocks.create, isPending: false }),
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
    await act(async () => button(en["returns.receiveCount"].replace("{count}", "3")).click());

    const [payload] = mocks.receive.mock.calls[0]!;
    expect(payload.expectedVersion).toBe(4);
    expect(payload.lines).toEqual([{ lineId: "line_1", receivedQuantity: 3, restockQuantity: 1, damagedQuantity: 2 }]);
  });

  it("expects every approved unit back in stock, and flags more than expected instead of changing it", async () => {
    const partlyReceived = {
      ...orderReturn,
      lines: [{ ...orderReturn.lines[0]!, receivedQuantity: 1, restockQuantity: 1 }],
    } as OrderReturnDto;
    await act(async () => root.render(
      <ReceiveReturnDialog orderReturn={partlyReceived} itemsById={itemsById} open onOpenChange={() => undefined} />,
    ));
    const name = "Shirt · M";
    const received = input(en["returns.receivedQty"].replace("{name}", name));
    expect(received.value).toBe("2");
    expect(input(en["returns.restockQty"].replace("{name}", name)).value).toBe("2");

    await act(async () => setNumber(received, "3"));
    expect(received.value).toBe("3");
    expect(received.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain(en["returns.receiveTooMany"].replace("{count}", "2"));
    // Nothing is derived from an invalid quantity: no "Receive 3", no damaged count (R3-ORD-16).
    expect(document.body.textContent).not.toContain(en["returns.receiveCount"].replace("{count}", "3"));
    expect(document.querySelector(`[aria-label="${en["returns.damagedQty"].replace("{count}", "1")}"]`)).toBeNull();
    const submit = button(en["returns.receiveSubmit"]) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => submit.click());
    expect(mocks.receive).not.toHaveBeenCalled();

    // Back to what is expected: back in stock follows and the receipt can be saved.
    await act(async () => setNumber(received, "1"));
    expect(input(en["returns.restockQty"].replace("{name}", name)).value).toBe("1");
    await act(async () => button(en["returns.receiveCount"].replace("{count}", "1")).click());
    const [payload] = mocks.receive.mock.calls[0]!;
    expect(payload.lines).toEqual([{ lineId: "line_1", receivedQuantity: 1, restockQuantity: 1, damagedQuantity: 0 }]);
  });

  it("only receives untracked items, never asking to restock them", async () => {
    const untracked = {
      ...orderReturn,
      lines: [{ ...orderReturn.lines[0]!, inventoryTracked: false }],
    } as OrderReturnDto;
    await act(async () => root.render(
      <ReceiveReturnDialog orderReturn={untracked} itemsById={itemsById} open onOpenChange={() => undefined} />,
    ));
    const name = "Shirt · M";
    expect(document.querySelector(`input[aria-label="${en["returns.restockQty"].replace("{name}", name)}"]`)).toBeNull();
    await act(async () => setNumber(input(en["returns.receivedQty"].replace("{name}", name)), "2"));
    await act(async () => button(en["returns.receiveCount"].replace("{count}", "2")).click());

    const [payload] = mocks.receive.mock.calls[0]!;
    expect(payload.lines).toEqual([{ lineId: "line_1", receivedQuantity: 2, restockQuantity: 0, damagedQuantity: 2 }]);
  });

  it("requests the whole returnable amount of a single line by default (R3-ORD-14)", async () => {
    const order = { id: "ord_1", version: 7, items: [item] } as unknown as Order;
    await act(async () => root.render(<CreateReturnDialog order={order} returns={[]} open onOpenChange={() => undefined} />));
    expect(input(en["returns.returnQty"].replace("{name}", "Shirt · M")).value).toBe("3");
    await act(async () => setNumber(document.querySelector<HTMLInputElement>("#return-reason")!, "Wrong size"));
    await act(async () => button(en["returns.request"]).click());
    const [payload] = mocks.create.mock.calls[0]!;
    expect(payload.lines).toEqual([{ orderItemId: "item_1", quantity: 3 }]);
  });

  it("asks to choose at least one item when every quantity is zero", async () => {
    const order = { id: "ord_1", version: 7, items: [item, { ...item, id: "item_2", variantLabel: "L" }] } as unknown as Order;
    await act(async () => root.render(<CreateReturnDialog order={order} returns={[]} open onOpenChange={() => undefined} />));
    await act(async () => setNumber(document.querySelector<HTMLInputElement>("#return-reason")!, "Wrong size"));
    await act(async () => button(en["returns.request"]).click());
    expect(document.body.textContent).toContain("Choose at least one item to return.");
    expect(mocks.create).not.toHaveBeenCalled();
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
