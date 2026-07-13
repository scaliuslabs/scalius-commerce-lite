import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const flowSource = readFileSync(
  fileURLToPath(new URL("./CheckoutFlowSettings.tsx", import.meta.url)),
  "utf8",
);
const gatewaysSource = readFileSync(
  fileURLToPath(new URL("./PaymentGatewaysManager.tsx", import.meta.url)),
  "utf8",
);
const pageSource = readFileSync(
  fileURLToPath(new URL("./CheckoutSettingsPage.tsx", import.meta.url)),
  "utf8",
);
const requestsSource = readFileSync(
  fileURLToPath(new URL("./CustomerRequestSettings.tsx", import.meta.url)),
  "utf8",
);

describe("checkout settings status presentation", () => {
  it("does not present missing initial data as a confirmed readiness failure", () => {
    expect(flowSource).toContain(
      "const paymentMethodsPending = !paymentMethods && !paymentMethodsError",
    );
    expect(flowSource).toContain(
      "const paymentMethodsUnavailable = !paymentMethods && paymentMethodsError",
    );
    expect(flowSource).toContain(
      "const readinessPending = !readiness && !checkoutReadinessError",
    );
    expect(flowSource).toContain('previewLoading\n        ? "border-border bg-card"');
  });

  it("names readiness and gateway facts instead of relying on color or icons", () => {
    for (const label of ["Checking", "Ready", "Unavailable", "Needs setup"]) {
      expect(flowSource).toContain(`label: "${label}"`);
    }
    expect(gatewaysSource).toContain("<dt className=\"text-muted-foreground\">Setup</dt>");
    expect(gatewaysSource).toContain("<dt className=\"text-muted-foreground\">Provider</dt>");
    expect(gatewaysSource).toContain("<dt className=\"text-muted-foreground\">Checkout</dt>");
    expect(gatewaysSource).toContain("Key environment");
    expect(gatewaysSource).toContain("Key mismatch");
    expect(gatewaysSource).toContain("@scalius/shared/payment-gateway-environment");
    expect(gatewaysSource).not.toContain("@scalius/core/modules/payments/gateway-settings");
  });

  it("keeps the tab strip mobile-safe and explains that refund requests are not automatic refunds", () => {
    expect(pageSource).toContain("overflow-x-auto");
    expect(pageSource).toContain("shrink-0 rounded-none");
    expect(requestsSource).toContain(
      "Approval and payment processing stay with the order.",
    );
  });
});
