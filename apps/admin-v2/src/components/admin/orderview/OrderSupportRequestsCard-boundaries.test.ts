import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./OrderSupportRequestsCard.tsx", import.meta.url)),
  "utf8",
);
const apiSource = readFileSync(
  fileURLToPath(new URL("../../../lib/api-functions/orders.ts", import.meta.url)),
  "utf8",
);

describe("OrderSupportRequestsCard boundaries", () => {
  it("collects item quantities before approving a buyer return request", () => {
    expect(source).toContain("orderReturnsQueryOptions(order.id)");
    expect(source).toContain("getRemainingReturnableQuantities");
    expect(source).toContain("expectedOrderVersion: order.version");
    expect(source).toContain('commandKey.current.get("support-request", returnRequest)');
    expect(source).toContain("Accept and create return case");
    expect(source).toContain('options.includes("approved")');
    expect(source).toContain("This opens a requested return case");
    expect(source).toContain("it does not authorize, refund, or restock items");
    expect(apiSource).toContain("returnRequest: data.returnRequest");
  });

  it("keeps the request row and item matrix narrow-screen safe", () => {
    expect(source).toContain("flex flex-col gap-3 sm:flex-row");
    expect(source).toContain("grid-cols-[minmax(0,1fr)_5.5rem]");
    expect(source).not.toContain("min-w-[");
  });
});
