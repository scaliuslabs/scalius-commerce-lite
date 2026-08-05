import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./index.tsx", import.meta.url)),
  "utf8",
);
const columnSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../components/admin/data-table/columns/discount-columns.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);
const mobileSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../components/admin/discount/DiscountMobileCard.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("discount list workflow", () => {
  it("uses a mobile-specific card instead of squeezing the desktop table", () => {
    expect(source).toContain("<DiscountMobileCard");
    expect(source).toContain("mobileCardRenderer={mobileCardRenderer}");
    expect(source).not.toContain(
      "Create codes, control eligibility, and monitor redemption.",
    );
    expect(source).toContain("View trash");
  });

  it("surfaces query failure with a retry instead of rendering a misleading empty list", () => {
    expect(source).toContain("error={error}");
    expect(source).toContain("onRetry={() => void refetch()}");
  });

  it("renders persisted schedule dates identically during SSR and hydration", () => {
    for (const presentationSource of [columnSource, mobileSource]) {
      expect(presentationSource).toContain("formatAdminDate");
      expect(presentationSource).not.toContain("formatDateShort");
      expect(presentationSource).not.toContain("suppressHydrationWarning");
    }
  });
});
