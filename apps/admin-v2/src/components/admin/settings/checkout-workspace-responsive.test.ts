import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

describe("checkout settings mobile workspace", () => {
  it("uses purpose-built language and shipping cards below the desktop table breakpoint", () => {
    const languages = source("../checkout-languages/LanguagesTable.tsx");
    const methods = source("../shipping-methods/MethodsTable.tsx");

    for (const table of [languages, methods]) {
      expect(table).toContain('className="space-y-3 p-2 md:hidden"');
      expect(table).toContain('className="hidden md:block"');
      expect(table).toContain("h-11 w-11");
      expect(table).toContain("aria-label={`Sort ${sort.order");
    }

    expect(languages).toContain('aria-label="Sort checkout languages by"');
    expect(languages).toContain("<article key={language.id}");
    expect(methods).toContain('aria-label="Sort shipping methods by"');
    expect(methods).toContain("<article key={method.id}");
    expect(methods).toContain("Select all {methods.length} on this page");
  });

  it("keeps phone toolbars and dialogs operable without inflating desktop density", () => {
    const languageContainer = source("../checkout-languages/CheckoutLanguagesContainer.tsx");
    const languageDialog = source("../checkout-languages/LanguageFormDialog.tsx");
    const methodContainer = source("../shipping-methods/ShippingMethodsContainer.tsx");
    const methodDialog = source("../shipping-methods/MethodFormDialog.tsx");
    const bulkActions = source("../shipping-methods/BulkActionsBar.tsx");
    const delivery = source("../delivery-locations/DeliveryLocationsContainer.tsx");
    const deliveryTable = source("../delivery-locations/LocationsTable.tsx");
    const requests = source("./CustomerRequestSettings.tsx");
    const payment = source("./PaymentGatewaysManager.tsx");

    expect(languageContainer).toContain("h-11 text-xs sm:h-7");
    expect(methodContainer).toContain("h-11 text-xs sm:h-7");
    expect(languageDialog).toContain("min-h-11 text-sm sm:min-h-9");
    expect(methodDialog).toContain("min-h-11 text-sm sm:min-h-9");
    expect(bulkActions).toContain("h-11 text-xs sm:h-7");
    expect(delivery).toContain("min-h-11 sm:min-h-9");
    expect(deliveryTable).toContain("h-11 w-11 sm:h-8 sm:w-8");
    expect(requests).toContain("min-h-11 px-2 py-1.5 text-xs sm:min-h-9");
    expect(payment).toContain('className="h-11 w-full sm:h-9"');
    expect(payment).toContain("flex min-h-11 shrink-0 cursor-pointer");
  });
});
