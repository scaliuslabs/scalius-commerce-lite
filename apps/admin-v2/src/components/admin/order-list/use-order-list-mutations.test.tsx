// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const sdk = vi.hoisted(() => ({
  postApiV1AdminOrdersArchive: vi.fn(async (_input: unknown) => undefined),
  postApiV1AdminOrdersByIdRestore: vi.fn(async (_input: unknown) => undefined),
  postApiV1AdminOrdersBulkConfirm: vi.fn(async ({ body }: { body: { orderIds: string[] } }) => ({
    results: body.orderIds.map((orderId) => ({ orderId, success: orderId !== "o-2", error: "Only new orders can be confirmed." })),
  })),
  postApiV1AdminOrdersBulkFulfill: vi.fn(),
  postApiV1AdminOrdersBulkShip: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));

import { useArchiveOrdersWithUndo, useOrderBulkRun } from "./use-order-list-mutations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let archive: ReturnType<typeof useArchiveOrdersWithUndo>;
let bulk: ReturnType<typeof useOrderBulkRun>;

function Harness() {
  archive = useArchiveOrdersWithUndo({ canUndo: true });
  bulk = useOrderBulkRun();
  return null;
}

describe("order list mutations", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("archives in 90-order batches and Undo restores each at its version + 1", async () => {
    const orders = Array.from({ length: 91 }, (_, index) => ({ id: `o-${index}`, version: 3 }));
    await act(async () => {
      await archive.mutateAsync({ orders, skipped: 1 });
    });
    expect(sdk.postApiV1AdminOrdersArchive).toHaveBeenCalledTimes(2);
    const [message, options] = toast.success.mock.calls[0] as [string, { duration: number; action: { onClick: () => void } }];
    expect(message).toBe("91 orders archived");
    expect(options.duration).toBe(10_000);

    await act(async () => {
      options.action.onClick();
      await vi.waitFor(() => expect(sdk.postApiV1AdminOrdersByIdRestore).toHaveBeenCalledTimes(91));
    });
    expect(sdk.postApiV1AdminOrdersByIdRestore).toHaveBeenCalledWith({ path: { id: "o-0" }, body: { expectedVersion: 4 } });
  });

  it("reports which orders didn't go through instead of failing the whole run", async () => {
    let outcome: Awaited<ReturnType<typeof bulk.mutateAsync>> | undefined;
    await act(async () => {
      outcome = await bulk.mutateAsync({ action: "confirm", orderIds: ["o-1", "o-2"] });
    });
    expect(outcome).toEqual({
      succeeded: ["o-1"],
      failures: [{ orderId: "o-2", error: "Only new orders can be confirmed." }],
    });
  });
});
