import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./invoice.$orderId.tsx", import.meta.url), "utf8");

describe("invoice delivery-method snapshot", () => {
  it("renders the saved delivery presentation while preserving the historical label", () => {
    expect(source).toContain(
      'resolveDeliveryMethodPresentation(order, savedSummary, "Shipping")',
    );
    expect(source).toContain("{delivery.label}");
    expect(source).toContain("{delivery.details}");
  });
});
