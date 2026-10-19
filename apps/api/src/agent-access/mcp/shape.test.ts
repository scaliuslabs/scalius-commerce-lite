import { describe, expect, it } from "vitest";
import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import { AgentDispatchError } from "../dispatch";
import { applyListControls, fitToBudget, jsonBytes, paginationMeta, selectPointers, unwrapRouteBody } from "./shape";

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

  it("turns each pagination style into one opaque cursor and restores it", () => {
    const versions = operation("dashboard.theme.versions_list");
    const meta = paginationMeta(versions, { versions: [], nextBeforeRevision: 15 });
    expect(meta).toMatchObject({ hasMore: true, nextCursor: expect.stringMatching(/^sc1\./) });
    expect(applyListControls(versions, {}, { cursor: meta.nextCursor! }).query).toMatchObject({ beforeRevision: 15 });
    expect(paginationMeta(versions, { versions: [], nextBeforeRevision: null })).toEqual({ hasMore: false, nextCursor: null });

    const orders = operation("dashboard.orders.list");
    const page = paginationMeta(orders, { orders: [], pagination: { page: 2, limit: 20, total: 45, totalPages: 3 } });
    expect(page).toMatchObject({ hasMore: true, total: 45 });
    expect(applyListControls(orders, { query: { status: "pending" } }, { cursor: page.nextCursor! }).query).toEqual({ status: "pending", page: 3 });
    expect(() => applyListControls(versions, {}, { cursor: page.nextCursor! })).toThrow(/does not belong/);
    expect(() => applyListControls(orders, {}, { cursor: "raw-cursor" })).toThrow(/does not page by cursor/);
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
