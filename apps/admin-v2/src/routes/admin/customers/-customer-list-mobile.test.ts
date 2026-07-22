import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./index.tsx", import.meta.url)),
  "utf8",
);
const historySource = readFileSync(
  fileURLToPath(
    new URL("../../../components/admin/CustomerHistoryView.tsx", import.meta.url),
  ),
  "utf8",
);

describe("customer directory responsive workflow", () => {
  it("uses the intentional mobile buyer card and truthful empty guidance", () => {
    expect(source).toContain("mobileCardRenderer={mobileCardRenderer}");
    expect(source).toContain("<CustomerMobileCard");
    expect(source).toContain("Guest and account buyers appear after checkout");
    expect(source).not.toContain("sync from your orders");
    expect(source).toContain("sm:flex-row sm:items-center sm:justify-between");
    expect(source).toContain("customer.totalOrders === 0");
    expect(source).toContain("setBulkDeleteRequested(true)");
    expect(source).toContain("customerCount={bulkDeleteRequested");
    expect(source).toContain('className="h-11 w-full sm:h-9 sm:w-auto"');
    expect(source).toContain('searchPlaceholder="Search customers…"');
    expect(source).not.toContain("Find every guest and account buyer");
  });

  it("bounds long customer names on the mobile history header", () => {
    expect(historySource).toContain('<div className="min-w-0">');
    expect(historySource).toContain("line-clamp-2 break-words");
    expect(historySource).not.toContain(
      'className="truncate text-xl font-bold tracking-tight',
    );
  });
});
