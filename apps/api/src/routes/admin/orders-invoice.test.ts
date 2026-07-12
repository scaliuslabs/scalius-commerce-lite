import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  fileURLToPath(new URL("./orders-invoice.ts", import.meta.url)),
  "utf8",
);

describe("admin invoice route boundaries", () => {
  it("keeps GET read-only and issuance explicit", () => {
    const getHandler = routeSource.slice(
      routeSource.indexOf("app.openapi(getInvoiceRoute"),
      routeSource.indexOf("app.openapi(issueInvoiceRoute"),
    );

    expect(getHandler).toContain("getInvoiceDocument");
    expect(getHandler).not.toContain("issueInvoice");
    expect(routeSource).toContain('method: "post"');
    expect(routeSource).toContain("operationKey");
    expect(routeSource).toContain("expectedOrderVersion");
  });

  it("documents draft, issued, integrity, and immutable render fields", () => {
    expect(routeSource).toContain('z.enum(["draft", "issued"])');
    expect(routeSource).toContain("contentHash");
    expect(routeSource).toContain('z.literal("invoice-v1")');
    expect(routeSource).toContain("orderVersion");
  });
});
