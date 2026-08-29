import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(path: string): string {
  return readFileSync(resolve(srcRoot, path), "utf8");
}

describe("incomplete checkout presentation", () => {
  it("uses checkout semantics consistently across the route and navigation", () => {
    const route = source("routes/admin/abandoned-checkouts.tsx");
    const navigation = source("components/admin/layout/AdminNav.ts");

    expect(route).toContain("Incomplete Checkouts | Scalius Admin");
    expect(route).toContain(">Incomplete Checkouts</h1>");
    expect(route).not.toContain("Incomplete Orders");
    expect(navigation).toContain('name: "Checkouts"');
  });

  it("keeps recovery IDs compact and shows readable delivery context", () => {
    const manager = source("components/admin/AbandonedCheckoutsManager.tsx");

    expect(manager).toContain("formatAbandonedCheckoutId(displayId)");
    expect(manager).toContain("customerInfo.location");
    expect(manager).toContain("Search checkouts…");
    expect(manager).toContain(
      "Empty checkouts are removed after 1 hour; all others after 30 days.",
    );
    expect(manager).not.toContain(
      "Recovery context for active checkouts and archived hosted payments.",
    );
    expect(manager).toContain("Delete checkout records?");
    expect(manager.match(/const \{ fmt \} = useCurrency\(\);/g)).toHaveLength(3);
    expect(manager).not.toContain("amount.toFixed(2)");
    expect(manager).toContain("Customer information");
    expect(manager).toContain("Cart items (");
    expect(manager).toContain('aria-label="Close incomplete checkout details"');
  });

  it("separates checkout, cart, provider, and payment status in desktop and mobile layouts", () => {
    const manager = source("components/admin/AbandonedCheckoutsManager.tsx");

    expect(manager).toContain("<TableHead>Checkout</TableHead>");
    expect(manager).toContain("<TableHead>Cart</TableHead>");
    expect(manager).toContain("<TableHead>Amount</TableHead>");
    expect(manager).toContain("<TableHead>Provider</TableHead>");
    expect(manager).toContain("<TableHead>Payment status</TableHead>");
    expect(manager).not.toContain("<TableHead>Saved cart</TableHead>");
    expect(manager).toContain(">Checkout type</dt>");
    expect(manager).toContain(">Checkout stage</dt>");
    expect(manager).toContain(">Cart contents</dt>");
    expect(manager).toContain("{presentation.amountLabel}</dt>");
    expect(manager).toContain(">Payment provider</dt>");
    expect(manager).toContain(">Payment status</dt>");
  });
});
