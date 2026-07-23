import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CARD_SOURCE = fileURLToPath(new URL("./OrderReturnsCard.tsx", import.meta.url));
const ORDER_VIEW_SOURCE = fileURLToPath(new URL("../OrderView.tsx", import.meta.url));
const CREATE_DIALOG_SOURCE = fileURLToPath(new URL("./order-returns/CreateReturnDialog.tsx", import.meta.url));
const APPROVE_DIALOG_SOURCE = fileURLToPath(new URL("./order-returns/ApproveReturnDialog.tsx", import.meta.url));
const RECEIVE_DIALOG_SOURCE = fileURLToPath(new URL("./order-returns/ReceiveReturnDialog.tsx", import.meta.url));
const RETURN_ROW_SOURCE = fileURLToPath(new URL("./order-returns/OrderReturnRow.tsx", import.meta.url));

describe("OrderReturnsCard boundaries", () => {
  it("keeps the item-level return workflow deterministic, payment-independent, and recovery-aware", () => {
    const card = readFileSync(CARD_SOURCE, "utf8");
    const orderView = readFileSync(ORDER_VIEW_SOURCE, "utf8");
    const createDialog = readFileSync(CREATE_DIALOG_SOURCE, "utf8");
    const receiveDialog = readFileSync(RECEIVE_DIALOG_SOURCE, "utf8");
    const returnRow = readFileSync(RETURN_ROW_SOURCE, "utf8");

    expect(orderView).toContain('import { OrderReturnsCard } from "./orderview/OrderReturnsCard"');
    expect(card).toContain("getRemainingReturnableQuantities");
    expect(card).toContain("itemsById={itemsById}");
    expect(card).toContain("Returns can be created after an item ships.");
    expect(card).toContain("There are no remaining items available to return.");
    expect(card).toContain("{canRequest && query.isSuccess ? (");
    expect(createDialog).toContain("Requesting a return does not refund payment or change stock.");
    expect(receiveDialog).toContain("Restock adds sellable inventory; damaged units do not.");
    expect(returnRow).toContain("Recover receipt");
    expect([card, createDialog, receiveDialog, returnRow].join("\n")).not.toContain("useRefundOrder");
    expect([card, createDialog, receiveDialog, returnRow].join("\n")).not.toContain("autoRefund");
  });

  it("uses legible controls and a stacked mobile return matrix", () => {
    const receiveDialog = readFileSync(RECEIVE_DIALOG_SOURCE, "utf8");

    expect(receiveDialog).toContain("sm:grid-cols-[minmax(10rem,1fr)_6rem_6rem_6rem]");
    expect(receiveDialog).toContain('className="sm:sr-only"');
    expect(receiveDialog).not.toContain("min-w-[36rem]");
    expect(receiveDialog).not.toContain("text-xs");
  });

  it("closes successful mutations and gives cancel actions a distinct accessible name", () => {
    const dialogs = [CREATE_DIALOG_SOURCE, APPROVE_DIALOG_SOURCE, RECEIVE_DIALOG_SOURCE]
      .map((path) => readFileSync(path, "utf8"));

    for (const dialog of dialogs) {
      expect(dialog).toContain("onSuccess: () => {");
      expect(dialog).toContain("onOpenChange(false);");
      expect(dialog).toContain(">Cancel</Button>");
      expect(dialog).not.toContain(">Close</Button>");
    }
  });
});
