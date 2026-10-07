// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fitColumns, fitWithStandIns, readSavedLayout, resolveOrder, writeSavedLayout, type LayoutColumn } from "./column-layout";

const column = (id: string, priority: number, minWidth: number, locked = false): LayoutColumn => ({ id, priority, minWidth, locked });

describe("column layout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hides the lowest-priority columns until the rest fit the container", () => {
    const columns = [
      column("select", Infinity, 40, true),
      column("product", Infinity, 200, true),
      column("sku", 80, 140),
      column("stock", 90, 100),
      column("vendor", 20, 140),
      column("updated", 30, 120),
      column("actions", Infinity, 56, true),
    ];
    // 796px of columns.
    expect([...fitColumns(columns, 1440)]).toEqual([]);
    expect([...fitColumns(columns, 700)]).toEqual(["vendor"]);
    expect([...fitColumns(columns, 540)]).toEqual(["vendor", "updated"]);
    expect([...fitColumns(columns, 400)]).toEqual(["vendor", "updated", "sku"]);
    // Locked columns never go, even when nothing else is left to hide.
    expect([...fitColumns(columns, 100)]).toEqual(["vendor", "updated", "sku", "stock"]);
    // Width not measured yet: show everything.
    expect([...fitColumns(columns, 0)]).toEqual([]);
  });

  it("steps extra columns aside when the rendered content is wider than the minimums", () => {
    const columns = [column("title", Infinity, 200, true), column("sku", 80, 140), column("stock", 90, 100), column("vendor", 20, 140)];
    expect([...fitColumns(columns, 1000, 1)]).toEqual(["vendor"]);
    expect([...fitColumns(columns, 1000, 2)]).toEqual(["vendor", "sku"]);
    expect([...fitColumns(columns, 1000, 9)]).toEqual(["vendor", "sku", "stock"]);
  });

  it("folds two columns into their stand-in when they no longer fit side by side, and only then", () => {
    const columns = [
      column("order", Infinity, 100, true),
      column("date", Infinity, 160, true),
      column("payment", 92, 130),
      column("fulfillment", 90, 130),
      column("status", 95, 110),
    ];
    const both = { ...column("both", 92, 140), combines: ["payment", "fulfillment"] };
    const ids = (width: number) => {
      const { columns: placed, hidden } = fitWithStandIns(columns, [both], width);
      return placed.filter((entry) => !hidden.has(entry.id)).map((entry) => entry.id);
    };
    // 630px side by side.
    expect(ids(630)).toEqual(["order", "date", "payment", "fulfillment", "status"]);
    // The stand-in takes the first one's place.
    expect(ids(600)).toEqual(["order", "date", "both", "status"]);
    expect(ids(510)).toEqual(["order", "date", "both", "status"]);
    // Narrower still, it steps aside like any column; the parts never come back alone.
    expect(ids(400)).toEqual(["order", "date", "status"]);
    // A list where the merchant hid one part has no stand-in.
    expect(fitWithStandIns(columns.filter((entry) => entry.id !== "fulfillment"), [both], 400).columns.map((entry) => entry.id)).not.toContain("both");
  });

  it("keeps one part shown on its own rather than a stand-in that has to step aside", () => {
    const columns = [column("order", Infinity, 100, true), column("payment", 92, 100), column("fulfillment", 90, 100)];
    const wide = { ...column("both", 92, 150), combines: ["payment", "fulfillment"] };
    const { columns: placed, hidden } = fitWithStandIns(columns, [wide], 210);
    expect(placed.filter((entry) => !hidden.has(entry.id)).map((entry) => entry.id)).toEqual(["order", "payment"]);
  });

  it("drops the later column first when priorities tie", () => {
    expect([...fitColumns([column("a", 50, 200), column("b", 50, 200)], 250)]).toEqual(["b"]);
  });

  it("keeps a saved order for columns that still exist and slots new ones where they belong", () => {
    expect(resolveOrder(["name", "sku", "stock"], undefined)).toEqual(["name", "sku", "stock"]);
    expect(resolveOrder(["name", "sku", "stock"], ["stock", "name", "sku"])).toEqual(["stock", "name", "sku"]);
    expect(resolveOrder(["name", "sku", "barcode", "stock"], ["stock", "name", "sku", "gone"])).toEqual(["stock", "name", "sku", "barcode"]);
    // The title column is pinned first, whatever the saved order (or a duplicate) says.
    expect(resolveOrder(["name", "sku", "stock"], ["stock", "name", "sku"], "name")).toEqual(["name", "stock", "sku"]);
    expect(resolveOrder(["name", "sku", "stock"], ["sku", "sku", "stock"], "name")).toEqual(["name", "sku", "stock"]);
    expect(resolveOrder(["sku", "name", "stock"], undefined, "name")).toEqual(["name", "sku", "stock"]);
  });

  it("saves the choice per list and survives blocked or corrupt storage", () => {
    writeSavedLayout("orders", { order: ["b", "a"], hidden: ["a"] });
    expect(readSavedLayout("orders")).toEqual({ order: ["b", "a"], hidden: ["a"] });
    localStorage.setItem("scalius.table.broken", "{not json");
    expect(readSavedLayout("broken")).toBeNull();
    writeSavedLayout("orders", null);
    expect(readSavedLayout("orders")).toBeNull();

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readSavedLayout("orders")).toBeNull();
    expect(() => writeSavedLayout("orders", { order: [], hidden: [] })).not.toThrow();
  });
});
