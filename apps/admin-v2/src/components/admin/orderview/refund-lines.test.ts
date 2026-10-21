import { describe, expect, it } from "vitest";
import { receivedReturnLineQuantities, refundLinesBody, refundableLines } from "./refund-lines";
import type { OrderItem } from "./types";

const line = (id: string, quantity: number, fulfillmentType: OrderItem["fulfillmentType"] = "ship") =>
  ({ id, quantity, fulfillmentType }) as OrderItem;

describe("refund lines", () => {
  const items = [line("a", 3), line("b", 1), line("g", 1, "gift_card")];

  it("lists every line except gift cards", () => {
    expect(refundableLines(items).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("omits the field when no quantity is named", () => {
    expect(refundLinesBody(items, {})).toBeUndefined();
    expect(refundLinesBody(items, { a: 0, g: 1 })).toBeUndefined();
  });

  it("sends only named lines, capped at the ordered quantity", () => {
    expect(refundLinesBody(items, { a: 2, b: 0, g: 1 })).toEqual([{ orderItemId: "a", quantity: 2 }]);
    expect(refundLinesBody(items, { a: 9, b: 1 })).toEqual([
      { orderItemId: "a", quantity: 3 },
      { orderItemId: "b", quantity: 1 },
    ]);
  });
});

describe("received return lines", () => {
  const items = [line("a", 3), line("b", 1), line("g", 1, "gift_card")];
  const back = (status: string, lines: Array<[string, number]>) =>
    ({ status, lines: lines.map(([orderItemId, receivedQuantity]) => ({ orderItemId, receivedQuantity })) }) as never;

  it("names what came back on live returns, capped at what was ordered", () => {
    expect(receivedReturnLineQuantities(items, [
      back("completed", [["a", 1], ["b", 0]]),
      back("receiving", [["a", 1]]),
      back("cancelled", [["b", 1]]),
    ], 0)).toEqual({ a: 2 });
    expect(receivedReturnLineQuantities(items, [back("completed", [["b", 4]])], 0)).toEqual({ b: 1 });
  });

  it("names nothing once money went back", () => {
    expect(receivedReturnLineQuantities(items, [back("completed", [["a", 1]])], 10)).toEqual({});
  });
});
