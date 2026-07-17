import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = process.cwd().endsWith("/apps/storefront")
  ? process.cwd()
  : resolve(process.cwd(), "apps/storefront");

const source = readFileSync(
  resolve(storefrontRoot, "src/components/CartFlyout.tsx"),
  "utf8",
);

describe("CartFlyout accessibility contract", () => {
  it("gives the Radix sheet an accessible description", () => {
    expect(source).toContain("SheetDescription");
    expect(source).toMatch(
      /<SheetContent[\s\S]*?<SheetDescription className="sr-only">[\s\S]*?Review cart items, change quantities, or continue to checkout\.[\s\S]*?<\/SheetDescription>[\s\S]*?<\/SheetContent>/,
    );
  });

  it("names every icon-only cart line action", () => {
    expect(source).toContain("aria-label={`Decrease ${item.name} quantity`}");
    expect(source).toContain("aria-label={`Increase ${item.name} quantity`}");
    expect(source).toContain("aria-label={`Remove ${item.name} from cart`}");
  });

  it("uses the ISO-aware currency formatter instead of browser number defaults", () => {
    expect(source).toContain("formatPriceShort(item.price * item.quantity)");
    expect(source).toContain("formatPriceShort(cart.totalAmount)");
    expect(source).not.toContain("toLocaleString()");
  });
});
