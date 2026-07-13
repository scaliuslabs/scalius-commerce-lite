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

  it("keeps checkout flow compact, mobile-safe, and explicit about immutable buyer facts", () => {
    expect(flowSource).toContain('method="post"');
    expect(flowSource).toContain("lg:grid-cols-[minmax(0,1fr)_20rem]");
    expect(flowSource).toContain("flex flex-col-reverse gap-2");
    expect(flowSource).toContain("w-full sm:w-auto sm:min-w-[164px]");
    expect(flowSource).toContain("Phone number is always required.");
    expect(flowSource).toContain("The remaining balance is due on delivery.");
    expect(flowSource).toContain("Unsaved checkout changes");
    expect(flowSource).toContain("Customer sign-in verification");
    expect(flowSource).toContain("readCheckoutFlowRevisionConflict");
    expect(flowSource).toContain("Your unsaved values are still here.");
    expect(flowSource).toContain("Merge my changes");
    expect(flowSource).toContain("Use latest saved version");
    expect(flowSource).toContain('aria-invalid={Boolean(partialPaymentAmountIssue)}');
    expect(flowSource).toContain('id="partial-payment-amount-error"');
    expect(flowSource).toContain('id="partial-payment-amount-help"');
    expect(flowSource).not.toContain("verified delivery phone");
    expect(flowSource).not.toContain("Customers pay ৳");
  });

  it("names readiness and gateway facts instead of relying on color or icons", () => {
    for (const label of ["Checking", "Ready", "Unavailable", "Needs setup"]) {
      expect(flowSource).toContain(`label: "${label}"`);
    }
    expect(gatewaysSource).toContain("<dt className=\"text-muted-foreground\">Setup</dt>");
    expect(gatewaysSource).toContain("<dt className=\"text-muted-foreground\">Provider</dt>");
    expect(gatewaysSource).toContain("<dt className=\"text-muted-foreground\">Checkout</dt>");
    expect(gatewaysSource).toContain("<dt className=\"text-muted-foreground\">Environment</dt>");
    expect(gatewaysSource).toContain("<dt className=\"text-muted-foreground\">Connection</dt>");
    expect(gatewaysSource).toContain("Card results preview this draft until you save.");
    expect(gatewaysSource).toContain("No provider connection health check is available.");
    expect(gatewaysSource).toContain("Key environment");
    expect(gatewaysSource).toContain("Key mismatch");
    expect(gatewaysSource).toContain("@scalius/shared/payment-gateway-environment");
    expect(gatewaysSource).not.toContain("@scalius/core/modules/payments/gateway-settings");
  });

  it("keeps payment-method saves stable and visible instead of flashing the full loader", () => {
    expect(gatewaysSource).toContain("const methodsDirty = enabledMethodsChanged || defaultMethod !== methods.defaultMethod");
    expect(gatewaysSource).toContain("Save payment methods");
    expect(gatewaysSource).toContain("loadMethods(false, false)");
    expect(gatewaysSource).toContain("Payment methods were saved, but their current status could not be refreshed.");
    expect(gatewaysSource).toContain("if (showInitialLoader) setMethods(null)");
    expect(gatewaysSource).toContain("The last loaded workspace is preserved, but saves are locked");
    expect(gatewaysSource).toContain("? { ...current, enabledMethods: nextEnabledMethods, defaultMethod }");
    expect(gatewaysSource).toContain("Buyer visibility cannot be confirmed until the saved checkout flow loads.");
  });

  it("keeps the tab strip mobile-safe and explains that refund requests are not automatic refunds", () => {
    expect(pageSource).toContain("overflow-x-auto");
    expect(pageSource).toContain("shrink-0 rounded-none");
    expect(requestsSource).toContain(
      "Approval and payment processing stay with the order.",
    );
  });
});
