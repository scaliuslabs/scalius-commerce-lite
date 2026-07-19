import { describe, expect, it } from "vitest";

import { getFormEntityLabel } from "./form-copy";

describe("shared form copy", () => {
  it.each([
    ["Pages", "New Page", "Page"],
    ["Customers", "New Customer", "Customer"],
    ["New analytics integration", undefined, "analytics integration"],
    ["Edit integration", undefined, "integration"],
  ])("normalizes %s without duplicating its action", (title, newLabel, expected) => {
    expect(getFormEntityLabel(title, newLabel)).toBe(expected);
  });
});
