import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

const inventoryMocks = vi.hoisted(() => ({
  applyClaimedInventoryEntryBatch: vi.fn(),
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyClaimedInventoryEntryBatch: inventoryMocks.applyClaimedInventoryEntryBatch,
}));

import {
  receiveOrderReturn,
  reconcileOrderReturnReceipt,
} from "./order-returns";
import type { ReceiveOrderReturnInput } from "./order-returns.validation";

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

async function receiveHash(orderId: string, returnId: string, input: ReceiveOrderReturnInput) {
  const payload = stableStringify({
    orderId,
    returnId,
    commandType: "receive",
    payload: input,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function createDb(options: {
  gets: unknown[];
  alls?: unknown[][];
  batches?: unknown[][][];
}) {
  const gets = [...options.gets];
  const alls = [...(options.alls ?? [])];
  const batches = [...(options.batches ?? [])];
  const batchCalls: unknown[][] = [];

  function selectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.innerJoin = () => chain;
    chain.leftJoin = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    chain.get = async () => gets.shift();
    chain.all = async () => alls.shift() ?? [];
    return chain;
  }

  function returningStatement(kind: string) {
    return { kind, id: crypto.randomUUID() };
  }

  const db = {
    select: () => selectChain(),
    insert: () => ({
      select: () => ({ returning: () => returningStatement("insert-select") }),
      values: () => ({ returning: () => returningStatement("insert-values") }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => returningStatement("update") }),
      }),
    }),
    batch: async (statements: unknown[]) => {
      batchCalls.push(statements);
      return batches.shift() ?? statements.map(() => [{ id: "ok" }]);
    },
  };
  return { db: db as unknown as Database, batchCalls };
}

const actor = { type: "admin" as const, id: "admin_1" };

describe("order return service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inventoryMocks.applyClaimedInventoryEntryBatch.mockResolvedValue(["movement_1"]);
  });

  it("replays an exact committed command and rejects same-key/different-payload", async () => {
    const input: ReceiveOrderReturnInput = {
      commandKey: "receive-command-1",
      expectedVersion: 2,
      lines: [{ lineId: "line_1", receivedQuantity: 1, restockQuantity: 1, damagedQuantity: 0 }],
    };
    const requestHash = await receiveHash("order_1", "ret_1", input);
    const replayResult = {
      orderId: "order_1", returnId: "ret_1", status: "completed",
      version: 3, restockedQuantity: 1, wholeOrderReturned: false,
    };
    const replayDb = createDb({
      gets: [{
        requestHash, status: "committed", responsePayload: JSON.stringify(replayResult),
        actorType: "admin", actorId: "admin_1",
      }, { status: "delivered" }],
    });

    await expect(receiveOrderReturn(replayDb.db, "order_1", "ret_1", input, actor))
      .resolves.toEqual(replayResult);
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();

    const conflictDb = createDb({
      gets: [{
        requestHash: "different", status: "committed", responsePayload: JSON.stringify(replayResult),
        actorType: "admin", actorId: "admin_1",
      }],
    });
    await expect(receiveOrderReturn(conflictDb.db, "order_1", "ret_1", input, actor))
      .rejects.toThrow("different payload");
  });

  it("keeps a partial receipt in receiving state and does not return the whole order", async () => {
    const input: ReceiveOrderReturnInput = {
      commandKey: "receive-partial-1",
      expectedVersion: 2,
      lines: [{ lineId: "line_1", receivedQuantity: 1, restockQuantity: 1, damagedQuantity: 0 }],
    };
    const requestHash = await receiveHash("order_1", "ret_1", input);
    const header = {
      id: "ret_1", status: "approved", version: 2,
      activeOrderKey: null, activeCommandKey: null, activeCommandHash: null,
    };
    const claimedHeader = {
      ...header, activeOrderKey: "order_1", activeCommandKey: input.commandKey,
      activeCommandHash: requestHash,
    };
    const lines = [{
      id: "line_1", orderItemId: "item_1", variantId: "sku_1", inventoryTracked: true,
      requestedQuantity: 2, approvedQuantity: 2, receivedQuantity: 0,
      restockQuantity: 0, damagedQuantity: 0, rejectedQuantity: 0, notes: null,
    }];
    const { db } = createDb({
      gets: [undefined, header, { status: "delivered", version: 10, inventoryPool: "regular" },
        claimedHeader, { status: "delivered", version: 11, inventoryPool: "regular" },
        { status: "delivered" }],
      alls: [lines, lines, [{ id: "item_1", quantity: 2 }, { id: "item_2", quantity: 1 }], [{
        returnId: "ret_1", lineId: "line_1", orderItemId: "item_1", receivedQuantity: 0, status: "approved",
      }]],
    });

    const result = await receiveOrderReturn(db, "order_1", "ret_1", input, actor);
    expect(result).toMatchObject({ status: "receiving", wholeOrderReturned: false, restockedQuantity: 1 });
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).toHaveBeenCalledWith(db, expect.objectContaining({
      operation: "restore", createdBy: "admin_1",
      claimKey: "return-receipt:v1:ret_1:receive-partial-1:line_1",
    }));
  });

  it("records a damaged receipt without any stock restore", async () => {
    const input: ReceiveOrderReturnInput = {
      commandKey: "receive-damaged-1",
      expectedVersion: 2,
      lines: [{ lineId: "line_1", receivedQuantity: 1, restockQuantity: 0, damagedQuantity: 1 }],
    };
    const requestHash = await receiveHash("order_1", "ret_1", input);
    const header = { id: "ret_1", status: "approved", version: 2, activeOrderKey: null, activeCommandKey: null, activeCommandHash: null };
    const lines = [{
      id: "line_1", orderItemId: "item_1", variantId: "sku_1", inventoryTracked: true,
      requestedQuantity: 1, approvedQuantity: 1, receivedQuantity: 0,
      restockQuantity: 0, damagedQuantity: 0, rejectedQuantity: 0, notes: null,
    }];
    const { db } = createDb({
      gets: [undefined, header, { status: "delivered", version: 10, inventoryPool: "regular" },
        { ...header, activeOrderKey: "order_1", activeCommandKey: input.commandKey, activeCommandHash: requestHash },
        { status: "delivered", version: 11, inventoryPool: "regular" }, { status: "returned" }],
      alls: [lines, lines, [{ id: "item_1", quantity: 1 }], [{
        returnId: "ret_1", lineId: "line_1", orderItemId: "item_1", receivedQuantity: 0, status: "approved",
      }]],
    });

    const result = await receiveOrderReturn(db, "order_1", "ret_1", input, actor);
    expect(result).toMatchObject({ status: "completed", restockedQuantity: 0, wholeOrderReturned: true });
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();
  });

  it("reconciles a lost-browser processing receipt from durable input", async () => {
    const input: ReceiveOrderReturnInput = {
      commandKey: "receive-recover-1",
      expectedVersion: 2,
      lines: [
        { lineId: "line_1", receivedQuantity: 1, restockQuantity: 1, damagedQuantity: 0 },
        { lineId: "line_2", receivedQuantity: 1, restockQuantity: 1, damagedQuantity: 0 },
      ],
    };
    const requestHash = await receiveHash("order_1", "ret_1", input);
    const processing = {
      requestHash, requestPayload: JSON.stringify(input), status: "processing", responsePayload: null,
      actorType: "admin", actorId: "admin_original",
    };
    const header = {
      id: "ret_1", status: "approved", version: 2, activeOrderKey: "order_1",
      activeCommandKey: input.commandKey, activeCommandHash: requestHash,
    };
    const lines = input.lines.map((line, index) => ({
      id: line.lineId, orderItemId: `item_${index + 1}`, variantId: `sku_${index + 1}`,
      inventoryTracked: true, requestedQuantity: 1, approvedQuantity: 1,
      receivedQuantity: 0, restockQuantity: 0, damagedQuantity: 0, rejectedQuantity: 0, notes: null,
    }));
    inventoryMocks.applyClaimedInventoryEntryBatch
      .mockResolvedValueOnce(["movement_1"])
      .mockResolvedValueOnce(["movement_2"]);
    const { db } = createDb({
      gets: [
        { commandKey: input.commandKey, commandHash: requestHash }, processing,
        processing, header, { status: "delivered", version: 11, inventoryPool: "regular" },
        { status: "delivered" },
      ],
      alls: [lines, [
        { id: "item_1", quantity: 1 }, { id: "item_2", quantity: 1 }, { id: "item_3", quantity: 1 },
      ], lines.map((line) => ({
        returnId: "ret_1", lineId: line.id, orderItemId: line.orderItemId,
        receivedQuantity: 0, status: "approved",
      }))],
    });

    const result = await reconcileOrderReturnReceipt(db, "order_1", "ret_1");
    expect(result).toMatchObject({ status: "completed", wholeOrderReturned: false, restockedQuantity: 2 });
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).toHaveBeenCalledTimes(2);
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).toHaveBeenNthCalledWith(1, db, expect.objectContaining({
      claimKey: "return-receipt:v1:ret_1:receive-recover-1:line_1", createdBy: "admin_original",
    }));
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).toHaveBeenNthCalledWith(2, db, expect.objectContaining({
      claimKey: "return-receipt:v1:ret_1:receive-recover-1:line_2", createdBy: "admin_original",
    }));
  });
});
