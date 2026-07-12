import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./invoice.$orderId.tsx", import.meta.url)),
  "utf8",
);
const orderHeaderSource = readFileSync(
  fileURLToPath(
    new URL("../components/admin/orderview/OrderViewHeader.tsx", import.meta.url),
  ),
  "utf8",
);

describe("invoice page authority", () => {
  it("does not redirect invoice read failures back to the order list", () => {
    expect(source).toContain("errorComponent: InvoiceError");
    expect(source).toContain("Invoice could not be loaded");
    expect(source).not.toContain(".catch(() => null)");
  });

  it("keeps draft documents unnumbered and retries issuance with one stable key", () => {
    expect(source).toContain('document.invoiceNumber ?? "Draft"');
    expect(source).toContain("No number has been allocated");
    expect(source).toContain("operationKey.current ??= createInvoiceOperationKey()");
    expect(source).toContain("expectedOrderVersion");
    expect(source).toContain("onIssued(document)");
  });

  it("offers print and PDF actions only after issuance", () => {
    expect(source).toContain("isIssued ? (");
    expect(source).toContain("<InvoiceActions invoiceNumber={invoiceNumber} />");
    expect(orderHeaderSource).toContain("View invoice");
    expect(orderHeaderSource).not.toContain("Print Invoice");
  });
});
