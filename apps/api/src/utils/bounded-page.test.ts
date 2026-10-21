import { describe, expect, it } from "vitest";
import { boundedPage } from "./bounded-page";

const items = [
  { id: "a", at: "2026-10-01T00:00:00.000Z" },
  { id: "b", at: "2026-10-01T00:00:00.000Z" },
  { id: "c", at: "2026-10-02T00:00:00.000Z" },
];
const page = (cursor: string | undefined, limit: number, list = items) =>
  boundedPage(list, { name: "things", cursor, limit, id: (item) => item.id, sort: { kind: "text", value: (item) => item.at } });

describe("bounded cursor pages", () => {
  it("returns every item and no cursor when the limit covers the list", () => {
    expect(page(undefined, 3)).toEqual({ items, nextCursor: null });
  });

  it("walks the list by sort value then id, without repeats or gaps when an item goes", () => {
    const first = page(undefined, 1);
    expect(first.items.map((item) => item.id)).toEqual(["a"]);
    const second = page(first.nextCursor!, 1, items.filter((item) => item.id !== "a"));
    expect(second.items.map((item) => item.id)).toEqual(["b"]);
    const third = page(second.nextCursor!, 5);
    expect(third).toEqual({ items: [items[2]], nextCursor: null });
  });

  it("refuses a cursor made for another list", () => {
    const other = boundedPage(items, { name: "others", cursor: undefined, limit: 1, id: (item) => item.id, sort: { kind: "text", value: (item) => item.at } });
    expect(() => page(other.nextCursor!, 1)).toThrow();
  });
});
