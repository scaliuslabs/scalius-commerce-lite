import { describe, expect, it } from "vitest";
import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import { AgentDispatchError } from "../dispatch";
import { applyListControls, cursorMeta, fitToBudget, jsonBytes, selectPointers, unwrapRouteBody } from "./shape";

const operation = (id: string) => {
  const found = AGENT_OPERATIONS_BY_ID[id];
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

describe("MCP response shaping", () => {
  it("unwraps only the success envelope", () => {
    expect(unwrapRouteBody({ success: true, data: { id: 1 } })).toEqual({ id: 1 });
    expect(unwrapRouteBody({ success: false, error: {} })).toEqual({ success: false, error: {} });
    expect(unwrapRouteBody("text")).toBe("text");
  });

  it("projects pointers with array wildcards, indexes and missing paths", () => {
    const value = { items: [{ id: "a", name: "A", deep: { x: 1, y: 2 } }, { id: "b", name: "B", deep: { x: 3 } }], total: 2 };
    expect(selectPointers(value, ["/items/*/id", "/items/*/deep/x", "/total", "/missing"])).toEqual({
      items: [{ id: "a", deep: { x: 1 } }, { id: "b", deep: { x: 3 } }],
      total: 2,
    });
    expect(selectPointers(value, ["/items/1/name"])).toEqual({ items: [null, { name: "B" }] });
    expect(selectPointers(value, ["/__proto__/polluted"])).toBeNull();
    expect(() => selectPointers(value, ["items"])).toThrow(AgentDispatchError);
    expect(() => selectPointers(value, Array.from({ length: 25 }, () => "/total"))).toThrow(/24/);
  });

  it("cuts the largest row array to the budget and outlines what has no rows", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: index, text: "x".repeat(200) }));
    const cut = fitToBudget({ rows, summary: { count: 100 } }, 4096);
    expect(jsonBytes(cut.data)).toBeLessThanOrEqual(4096);
    expect(cut.meta).toMatchObject({ truncated: true, pageRows: 100 });
    expect((cut.data as { rows: unknown[] }).rows).toHaveLength(cut.meta.returned!);
    const blob = fitToBudget({ document: "y".repeat(20_000), revision: 4 }, 2048);
    expect(blob.data).toEqual({ document: "<string, 20002 bytes>", revision: 4 });
    expect(blob.meta.truncated).toBe(true);
    expect(fitToBudget({ ok: 1 }, 8192)).toEqual({ data: { ok: 1 }, meta: {} });
  });

  it("keeps the newest days of an oldest-first series, and the head of a paged list", () => {
    // home.activity's 90-day default: oldest first, today last.
    const start = Date.UTC(2026, 6, 23);
    const dailyActivityData = Array.from({ length: 90 }, (_, index) => ({
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      orders: index,
      revenue: index * 1000,
      newCustomers: 0,
    }));
    const today = dailyActivityData.at(-1)!;
    const cut = fitToBudget({ dailyActivityData }, 2048);
    const kept = (cut.data as { dailyActivityData: typeof dailyActivityData }).dailyActivityData;
    expect(jsonBytes(cut.data)).toBeLessThanOrEqual(2048);
    expect(kept.length).toBe(cut.meta.returned);
    expect(kept.length).toBeLessThan(90);
    expect(kept.at(-1)).toEqual(today);
    expect(kept[0]).toEqual(dailyActivityData[90 - kept.length]);
    expect(cut.meta.hint).toMatch(/oldest rows were dropped/);

    // A cursor continues after the page's last row: a paged list keeps its head, whatever its order.
    const paged = fitToBudget({ dailyActivityData }, 2048, { paged: true });
    expect((paged.data as { dailyActivityData: unknown[] }).dailyActivityData[0]).toEqual(dailyActivityData[0]);

    // Newest-first rows, or rows without dates, keep the head as before.
    const newestFirst = fitToBudget({ rows: [...dailyActivityData].reverse() }, 2048);
    expect((newestFirst.data as { rows: unknown[] }).rows[0]).toEqual(today);
  });

  it("reports a cursor list's next page and passes the cursor straight back", () => {
    const orders = operation("dashboard.resources.orders.list");
    expect(cursorMeta({ orders: [], nextCursor: "abc" })).toEqual({ hasMore: true, nextCursor: "abc" });
    expect(cursorMeta({ orders: [], nextCursor: null })).toEqual({ hasMore: false, nextCursor: null });
    // Only cursor lists page through the tool: a page-numbered list reads its own `page`.
    expect(cursorMeta({ orders: [], pagination: { page: 2, totalPages: 3 } })).toEqual({});
    expect(applyListControls(orders, { query: { status: "pending" } }, { cursor: "abc" }).query).toMatchObject({ status: "pending", cursor: "abc" });
    expect(() => applyListControls(operation("dashboard.orders.list"), {}, { cursor: "abc" })).toThrow(/does not page by cursor/);
  });

  it("defaults list limits to 20 within the operation's own maximum", () => {
    const withoutDefault = Object.values(AGENT_OPERATIONS_BY_ID).find((candidate) => {
      const parameters = (candidate.inputSchema as { parameters?: Array<{ in: string; name: string; schema?: { default?: unknown; maximum?: unknown } }> })?.parameters ?? [];
      const limit = parameters.find((parameter) => parameter.in === "query" && parameter.name === "limit");
      return candidate.risk === "read" && limit && limit.schema?.default === undefined && limit.schema?.maximum === 100;
    })!;
    expect(applyListControls(withoutDefault, {}, {}).query).toEqual({ limit: 20 });
    expect(applyListControls(withoutDefault, {}, { limit: 500 }).query).toEqual({ limit: 100 });
    expect(() => applyListControls(operation("dashboard.settings.currency_get"), {}, { limit: 5 })).toThrow(/no limit/);
  });
});
