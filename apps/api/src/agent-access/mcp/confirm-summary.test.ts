// What a merchant reads before approving an agent's change (black-box M7):
// counts in words ("3 products"), never raw parameter names ("productIds=1
// items"), and the records the bound input names, by kind, for the approval
// page to resolve to titles, SKUs, order numbers and customer names.
import { describe, expect, it } from "vitest";
import type { AgentOperationPolicy } from "../../openapi/agent-operation-manifest";
import { confirmSummary, confirmTargets, countedNoun } from "./confirm";

function operation(operationId: string, pathTemplate: string, summary: string): AgentOperationPolicy {
  return { operationId, pathTemplate, summary, method: "POST", risk: "destructive" } as AgentOperationPolicy;
}

const bulkDelete = operation("dashboard.products.bulk_delete", "/api/v1/admin/products/bulk-delete", "Bulk delete products");
const retire = operation("dashboard.product_variants.retire", "/api/v1/admin/products/{id}/variants/{variantId}", "Retire a variant");
const refund = { ...operation("dashboard.orders.refund", "/api/v1/admin/orders/{id}/refund", "Refund an order"), risk: "financial" } as AgentOperationPolicy;
const customers = operation("dashboard.customers.bulk_delete", "/api/v1/admin/customers/bulk-delete", "Bulk delete customers");

describe("the approval summary", () => {
  it("counts lists in words", () => {
    expect(countedNoun("productIds", 1)).toBe("1 product");
    expect(countedNoun("products", 3)).toBe("3 products");
    expect(countedNoun("categories", 2)).toBe("2 categories");
    expect(countedNoun("addresses", 1)).toBe("1 address");
    expect(countedNoun("ids", 4)).toBe("4 items");
    expect(confirmSummary([{ operation: bulkDelete, input: { body: { products: [{ id: "p1", expectedAggregateRevision: 1 }] } } }]))
      .toBe("Bulk delete products: 1 product");
    expect(confirmSummary([{ operation: customers, input: { body: { matching: { search: "x" }, permanent: true } } }]))
      .toBe("Bulk delete customers: all matching a filter, permanent=true");
    expect(confirmSummary([{ operation: refund, input: { path: { id: "ord_1" }, body: { amount: 500, lines: [{}, {}] } } }]))
      .toBe("Refund an order: id=ord_1, amount=500, 2 lines");
  });

  it("names the records the bound input acts on, by kind", () => {
    expect(confirmTargets([
      { operation: bulkDelete, input: { body: { products: [{ id: "p1", expectedAggregateRevision: 1 }, { id: "p2", expectedAggregateRevision: 3 }] } } },
      { operation: retire, input: { path: { id: "p1", variantId: "v9" } } },
      { operation: refund, input: { path: { id: "ord_1" }, body: { amount: 500 } } },
      { operation: customers, input: { body: { customerIds: ["c1"], matching: { search: "x" } } } },
    ])).toEqual([
      { kind: "product", ids: ["p1", "p2"], total: 2, matching: false },
      { kind: "variant", ids: ["v9"], total: 1, matching: false },
      { kind: "order", ids: ["ord_1"], total: 1, matching: false },
      { kind: "customer", ids: ["c1"], total: 1, matching: true },
    ]);
  });

  it("keeps at most 20 ids per kind for names and counts the rest", () => {
    const ids = Array.from({ length: 45 }, (_, index) => ({ id: `p${index}`, expectedAggregateRevision: 1 }));
    const [target] = confirmTargets([{ operation: bulkDelete, input: { body: { products: ids } } }]);
    expect(target).toMatchObject({ kind: "product", total: 45 });
    expect(target!.ids).toHaveLength(20);
  });
});
