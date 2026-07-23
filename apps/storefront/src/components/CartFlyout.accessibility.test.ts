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
    expect(source).toContain('aria-label="Close cart"');
    expect(source).toContain("aria-label={`Decrease ${item.name} quantity`}");
    expect(source).toContain("aria-label={`Increase ${item.name} quantity`}");
    expect(source).toContain("aria-label={`Remove ${item.name} from cart`}");
  });

  it("keeps every phone cart action touch-friendly", () => {
    expect(source).toContain(
      'className="group -mr-2 flex h-11 w-11 items-center justify-center',
    );
    expect(source).toContain(
      'className="mt-1 h-11 rounded-full bg-primary px-5',
    );
    expect(source).toContain(
      'className="flex h-11 items-center overflow-hidden rounded-md bg-muted/50 ring-1',
    );
    expect(source).toContain(
      'className="flex h-full w-11 items-center justify-center',
    );
    expect(source).toContain(
      'className="flex h-11 w-11 items-center justify-center rounded-md',
    );
    expect(source).toContain('aria-label="Clear cart"');
    expect(source).toContain(
      'className="ml-auto flex h-11 flex-1 items-center justify-center',
    );
  });

  it("uses the ISO-aware currency formatter instead of browser number defaults", () => {
    expect(source).toContain("formatPriceShort(item.price * item.quantity)");
    expect(source).toContain("formatPriceShort(cart.totalAmount)");
    expect(source).not.toContain("toLocaleString()");
  });
});
