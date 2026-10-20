// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderReturnMessages } from "~/i18n/order-returns";
import type { OrderReturnDto } from "~/lib/order-return-workflow";
import type { Order, OrderItem } from "../types";
import { ApproveReturnDialog } from "./ApproveReturnDialog";
import { CreateReturnDialog } from "./CreateReturnDialog";
import { OrderReturnRow } from "./OrderReturnRow";
import { ReceiveReturnDialog } from "./ReceiveReturnDialog";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  receive: vi.fn(),
  create: vi.fn(),
  locations: vi.fn(),
  inventory: vi.fn(),
}));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminInventoryLocations: mocks.locations,
  getApiV1AdminInventory: mocks.inventory,
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useCreateOrderReturn: () => ({ mutate: mocks.create, isPending: false }),
  useApproveOrderReturn: () => ({ mutate: mocks.approve, isPending: false }),
  useReceiveOrderReturn: () => ({ mutate: mocks.receive, isPending: false }),
  useReconcileOrderReturn: () => ({ mutate: vi.fn(), isPending: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderReturnMessages.en;

const item = {
  id: "item_1", productId: "p1", variantId: "v1", quantity: 3, price: 500,
  productName: "Shirt", productImage: null, variantLabel: "M", fulfillmentType: "ship", fulfilledQuantity: 3,
} satisfies OrderItem;
const orderReturn = {
  id: "ret_1", orderId: "ord_1", version: 4, status: "approved", reason: "Wrong size",
  lines: [{
    id: "line_1", orderItemId: "item_1", requestedQuantity: 3, approvedQuantity: 3, receivedQuantity: 0,
    restockQuantity: 0, damagedQuantity: 0, inventoryTracked: true, reason: null,
  }],
  receipts: [],
} as unknown as OrderReturnDto;
const itemsById = new Map([[item.id, item]]);
const location = (id: string, name: string, isDefault: boolean) => ({ id, name, isDefault, status: "active" });
/** The receive dialog reads the store's locations (and where the units were sent from). */
const withQueries = (node: ReactNode) => <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

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
    mocks.locations.mockResolvedValue({ locations: [location("loc_default", "Main location", true)] });
    mocks.inventory.mockResolvedValue({ movements: [], pageInfo: { limit: 100, hasMore: false, nextCursor: null } });
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
      withQueries(<ReceiveReturnDialog orderReturn={orderReturn} itemsById={itemsById} open onOpenChange={() => undefined} />),
    ));
    const name = "Shirt · M";
    await act(async () => setNumber(input(en["returns.receivedQty"].replace("{name}", name)), "3"));
    await act(async () => setNumber(input(en["returns.restockQty"].replace("{name}", name)), "1"));
    await act(async () => button(en["returns.receiveCount"].replace("{count}", "3")).click());

    const [payload] = mocks.receive.mock.calls[0]!;
    expect(payload.expectedVersion).toBe(4);
    expect(payload.lines).toEqual([{ lineId: "line_1", receivedQuantity: 3, restockQuantity: 1, damagedQuantity: 2 }]);
    // One location: nothing to choose, and the API restocks where the units were sent from.
    expect(document.body.textContent).not.toContain(en["returns.restockAt"]);
    expect(payload).not.toHaveProperty("restockLocationId");
  });

  it("restocks where the units were sent from by default, or at a location the merchant picks", async () => {
    mocks.locations.mockResolvedValue({
      locations: [location("loc_default", "Main location", true), location("loc_branch", "Banani store", false)],
    });
    mocks.inventory.mockResolvedValue({
      movements: [{ id: "move_1", variantId: "v1", type: "deducted", locationId: "loc_branch", locationName: "Banani store" }],
      pageInfo: { limit: 100, hasMore: false, nextCursor: null },
    });
    const returned = {
      ...orderReturn,
      lines: [{ ...orderReturn.lines[0]!, variantId: "v1" }],
    } as OrderReturnDto;
    await act(async () => root.render(
      withQueries(<ReceiveReturnDialog orderReturn={returned} itemsById={itemsById} open onOpenChange={() => undefined} />),
    ));
    await settle();
    await settle();

    expect(mocks.inventory).toHaveBeenCalledWith({
      query: expect.objectContaining({ section: "movements", movementOrderId: "ord_1", movementType: "deducted" }),
    });
    const trigger = document.getElementById("receipt-location-ret_1")!;
    expect(trigger.textContent).toBe(en["returns.restockSentFromNamed"].replace("{name}", "Banani store"));

    // The default omits the location: the API resolves it per unit.
    await act(async () => button(en["returns.receiveCount"].replace("{count}", "3")).click());
    expect(mocks.receive.mock.calls[0]![0]).not.toHaveProperty("restockLocationId");

    await act(async () => trigger.click());
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      en["returns.restockSentFromNamed"].replace("{name}", "Banani store"),
      en["location.default"].replace("{name}", "Main location"),
    ]);
    await act(async () => options[1]!.click());
    await act(async () => button(en["returns.receiveCount"].replace("{count}", "3")).click());
    expect(mocks.receive.mock.calls[1]![0]).toMatchObject({ restockLocationId: "loc_default" });
  });

  it("expects every approved unit back in stock, and flags more than expected instead of changing it", async () => {
    const partlyReceived = {
      ...orderReturn,
      lines: [{ ...orderReturn.lines[0]!, receivedQuantity: 1, restockQuantity: 1 }],
    } as OrderReturnDto;
    await act(async () => root.render(
      withQueries(<ReceiveReturnDialog orderReturn={partlyReceived} itemsById={itemsById} open onOpenChange={() => undefined} />),
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
      withQueries(<ReceiveReturnDialog orderReturn={untracked} itemsById={itemsById} open onOpenChange={() => undefined} />),
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

  it("names where a receipt's units went back into stock once a store has several locations", async () => {
    mocks.locations.mockResolvedValue({
      locations: [location("loc_default", "Main location", true), location("loc_branch", "Banani store", false)],
    });
    const received = {
      ...orderReturn,
      status: "completed",
      createdAt: new Date("2026-10-01T10:00:00Z"),
      receipts: [{
        id: "rcpt_1", returnLineId: "line_1", receivedQuantity: 3, restockQuantity: 2, damagedQuantity: 1,
        restockLocationId: "loc_branch", createdAt: new Date("2026-10-02T10:00:00Z"),
      }],
    } as unknown as OrderReturnDto;
    await act(async () => root.render(withQueries(
      <ul><OrderReturnRow orderReturn={received} itemsById={itemsById} canManage={false} onAction={() => undefined} /></ul>,
    )));
    await settle();

    expect(document.body.textContent).toContain(en["returns.restockedAt"].replace("{location}", "Banani store"));
  });
});
