import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const adminOrderSource = readFileSync(
  fileURLToPath(new URL("./orders.admin.ts", import.meta.url)),
  "utf8",
);

describe("issued invoice order boundaries", () => {
  it("blocks full replacement and permanent deletion after issuance", () => {
    expect(adminOrderSource).toContain("async function assertOrderHasNoIssuedInvoice");
    expect(adminOrderSource).toContain("Issued invoice facts are immutable");
    expect(adminOrderSource.match(/await assertOrderHasNoIssuedInvoice\(db, id\)/g)).toHaveLength(2);
    expect(adminOrderSource).toContain("await assertOrderHasNoIssuedInvoice(db, order.id)");
  });
});
