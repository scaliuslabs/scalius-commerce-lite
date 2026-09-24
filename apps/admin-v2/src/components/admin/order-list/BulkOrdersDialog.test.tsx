// @vitest-environment happy-dom

import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

type BulkBody = { orderIds: string[]; requestKey?: string; courierName?: string };
const sdk = vi.hoisted(() => ({
  postApiV1AdminOrdersArchive: vi.fn(),
  postApiV1AdminOrdersByIdRestore: vi.fn(),
  postApiV1AdminOrdersBulkConfirm: vi.fn(),
  postApiV1AdminOrdersBulkFulfill: vi.fn(),
  postApiV1AdminOrdersBulkShip: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: () => "Failed",
  useUpdateOrderStatus: () => ({ mutate: vi.fn() }),
  useRestoreOrder: () => ({ mutate: vi.fn() }),
}));

import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { BulkOrdersDialog } from "./BulkOrdersDialog";
import { useOrderActions, type OrderSelection } from "./use-order-actions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const order = (id: string, orderNumber: number, status: string) => ({
  id,
  orderNumber,
  status,
  version: 1,
  activeRefundOperation: null,
  paymentRecovery: { state: "none" },
  shipmentRecovery: { activeLock: false },
}) as unknown as OrderListItem;

const selected = [order("o-1", 1050, "confirmed"), order("o-2", 1051, "confirmed"), order("o-3", 1044, "refunded")];
const selection = { clear: vi.fn(), deselect: vi.fn() };

function Harness() {
  const ref = useRef<OrderSelection>({ rows: selected, ...selection });
  const actions = useOrderActions({ canDeleteOrders: true } as OrderActionPermissions, ref);
  const { openBulk } = actions;
  useEffect(() => openBulk("send", selected), [openBulk]);
  return (
    <BulkOrdersDialog
      action={actions.dialog?.action ?? null}
      orders={actions.dialog?.orders ?? null}
      selectedCount={selected.length}
      running={actions.running}
      outcome={actions.outcome}
      onOpenChange={(open) => {
        if (!open) actions.closeBulk();
      }}
      onRun={actions.runBulk}
    />
  );
}

const button = (name: string) =>
  Array.from(document.body.querySelectorAll("button")).find((candidate) => candidate.textContent === name);

describe("bulk Mark as sent", () => {
  let root: Root;

  beforeEach(async () => {
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("counts only the orders it will send, sends one request for a double click and closes with a summary", async () => {
    let finish: () => void = () => undefined;
    sdk.postApiV1AdminOrdersBulkFulfill.mockImplementation(({ body }: { body: BulkBody }) =>
      new Promise((resolve) => {
        finish = () => resolve({ results: body.orderIds.map((orderId) => ({ orderId, success: true })) });
      }));

    expect(document.body.textContent).toContain("Mark 2 orders as sent");
    const run = button("Mark as sent")!;
    await act(async () => {
      run.click();
      run.click();
    });
    expect(sdk.postApiV1AdminOrdersBulkFulfill).toHaveBeenCalledTimes(1);
    const { body } = sdk.postApiV1AdminOrdersBulkFulfill.mock.calls[0]![0] as { body: BulkBody };
    expect(body.orderIds).toEqual(["o-1", "o-2"]);
    expect(body.requestKey).toMatch(/^[0-9a-f-]{36}$/);

    await act(async () => finish());
    expect(toast.success).toHaveBeenCalledWith("2 orders marked as sent · 1 skipped");
    expect(selection.clear).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a truly failed order in the dialog and retries it with the same request key", async () => {
    sdk.postApiV1AdminOrdersBulkFulfill.mockImplementation(async ({ body }: { body: BulkBody }) => ({
      results: body.orderIds.map((orderId) => ({
        orderId,
        success: orderId !== "o-2" || sdk.postApiV1AdminOrdersBulkFulfill.mock.calls.length > 1,
        error: "Couldn't reach the courier.",
      })),
    }));

    await act(async () => button("Mark as sent")!.click());
    expect(document.body.textContent).toContain("1 of 2 done");
    expect(document.body.textContent).toContain("#1051: Couldn't reach the courier.");
    expect(selection.deselect).toHaveBeenCalledWith(["o-1"]);
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => button("Mark as sent")!.click());
    const [first, second] = sdk.postApiV1AdminOrdersBulkFulfill.mock.calls.map(([input]) => (input as { body: BulkBody }).body);
    expect(second!.orderIds).toEqual(["o-2"]);
    expect(second!.requestKey).toBe(first!.requestKey);
    expect(toast.success).toHaveBeenCalledWith("1 order marked as sent");
  });
});
