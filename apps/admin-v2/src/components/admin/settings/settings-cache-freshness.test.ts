import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

describe("settings cache freshness boundaries", () => {
  it("publishes the canonical country policy and refreshes checkout readiness", () => {
    const countries = source("./AllowedCountriesBuilder.tsx");

    expect(countries).toContain("getAllowedCountries()\n          .then((policy)");
    expect(countries).toContain(
      "queryClient.setQueryData(queryKeys.settings.allowedCountries(), savedPolicy)",
    );
    expect(countries).toContain("queryKeys.settings.checkoutReadiness()");
  });

  it("waits for payment method and gateway readiness invalidations", () => {
    const gateways = source("./PaymentGatewaysManager.tsx");

    expect(gateways.match(/queryKeys\.settings\.checkoutReadiness\(\)/g)).toHaveLength(2);
    expect(gateways.match(/await Promise\.all\(\[/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("waits for delivery-provider and checkout-readiness refreshes after durable writes", () => {
    const providers = source("../delivery-providers/DeliveryProvidersContainer.tsx");

    expect(providers).toContain("const refreshDeliveryProviderQueries = async () =>");
    expect(providers).toContain("queryKeys.settings.checkoutReadiness()");
    expect(providers.match(/await refreshDeliveryProviderQueries\(\)/g)).toHaveLength(3);
    expect(providers).toContain("queryClient.getQueryData<DeliveryProviderRecord[]>");
  });

  it("refreshes auth readiness after email settings change", () => {
    const email = source("./EmailSettingsForm.tsx");

    expect(email).toContain("queryKeys.settings.email()");
    expect(email).toContain("queryKeys.settings.auth()");
  });
});
