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
const gatewayUtilsSource = readFileSync(
  fileURLToPath(new URL("./payment-gateway-utils.tsx", import.meta.url)),
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
    // Loading is a neutral tone; only a confirmed issue is critical.
    expect(flowSource).toContain(
      'previewLoading\n        ? { label: "Checking", tone: "neutral" }',
    );
    expect(flowSource).toContain(
      'hasConfirmedPreviewIssue\n            ? { label: "Needs setup", tone: "critical" }',
    );
  });

  it("keeps checkout flow compact, mobile-safe, and explicit about immutable buyer facts", () => {
    expect(flowSource).toContain('method="post"');
    // One annotated section per group and exactly one page-level save bar.
    expect(flowSource.match(/<SettingsSection/g)).toHaveLength(4);
    expect(flowSource.match(/<ContextualSaveBar/g)).toHaveLength(1);
    expect(flowSource).toContain('saveLabel="Save checkout flow"');
    expect(flowSource).toContain('stickyClassName="sticky top-15 z-30 lg:top-0"');
    expect(flowSource).toContain("allowSamePathNavigation");
    // No per-card save/reset row survives beside the bar.
    expect(flowSource).not.toContain('type="submit"');
    expect(flowSource).not.toContain("Reset");
    expect(flowSource.match(/flex min-h-11 min-w-11 shrink-0 items-center justify-end/g)).toHaveLength(2);
    expect(flowSource).toContain("Phone number is always required.");
    expect(flowSource).toContain("The remaining balance is due on delivery.");
    expect(flowSource).toContain("Unsaved checkout changes");
    expect(flowSource).toContain("Customer sign-in verification");
    expect(flowSource).toContain("readCheckoutFlowRevisionConflict");
    expect(flowSource).toContain("Your unsaved values are still here.");
    expect(flowSource).toContain("Merge my changes");
    expect(flowSource).toContain("Use latest saved version");
    expect(flowSource).not.toContain("<UnsavedChangesGuard");
    expect(flowSource).toContain("Customer sign-in verification must be ready before requiring an account");
    expect(flowSource).toContain("checkoutSettingsStale");
    expect(flowSource).toContain("Your draft is preserved and saving is locked.");
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
    expect(gatewaysSource).toContain("getMethodOutcome(method).environmentLabel");
    expect(gatewaysSource).toContain("Choose which eligible methods appear at checkout, their display order, and the preselected option.");
    expect(gatewaysSource).toContain("Checkout display order");
    expect(gatewaysSource).toContain("Move ${META[method].label} up");
    expect(gatewaysSource).toContain("Move ${META[method].label} down");
    expect(gatewaysSource).toContain("At checkout");
    expect(gatewaysSource).toContain("SSLCommerz checkout requires BDT. Current store currency:");
    expect(gatewaysSource).toContain("Payment-method eligibility and saves stay locked until the store currency is known.");
    expect(gatewaysSource).not.toContain("<dt className=\"text-muted-foreground\">Setup</dt>");
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
    expect(gatewaysSource).toContain("loadMethods(false, false, true)");
    expect(gatewaysSource).toContain("loadMethods(false, true, true)");
    expect(gatewaysSource).toContain("getEligibleDefaultPaymentMethods");
    expect(gatewaysSource).not.toContain("<UnsavedChangesGuard");
    expect(gatewaysSource.match(/<ContextualSaveBar/g)).toHaveLength(1);
    expect(gatewaysSource).toContain('saveLabel="Save payment methods"');
    expect(gatewaysSource).toContain("dirty={stripeDirty}");
    expect(gatewaysSource).toContain("dirty={sslDirty}");
    expect(gatewaysSource).toContain("dirty={polarDirty}");
    expect(gatewaysSource).toContain("<IndexTable");
    expect(gatewaysSource).toContain('label="Loading payment settings"');
    expect(gatewayUtilsSource).toContain("Provider settings saved");
    expect(gatewayUtilsSource).toContain("Unsaved provider changes");
    expect(gatewayUtilsSource).toContain('aria-label={`${show ? "Hide" : "Show"} credential value`}');
    expect(gatewayUtilsSource).not.toContain("tabIndex={-1}");
  });

  it("keeps the tab strip mobile-safe and explains that refund requests are not automatic refunds", () => {
    expect(pageSource).toContain("overflow-x-auto");
    expect(pageSource).toContain("min-h-11 shrink-0");
    expect(pageSource).toContain("shrink-0 rounded-none");
    expect(pageSource).toContain('aria-label="Checkout settings section"');
    expect(pageSource).toContain('className="mb-4 sm:hidden"');
    expect(pageSource).toContain("sm:flex");
    expect(pageSource).toContain('aria-label="Checkout settings sections"');
    expect(pageSource).toContain("list.scrollTo");
    expect(pageSource).toContain("getNearestTabScrollLeft");
    expect(pageSource).toContain("scrollLeft: list.scrollLeft");
    expect(pageSource).toContain("tabOffsetLeft: activeTab.offsetLeft");
    expect(requestsSource).toContain(
      "Approval and payment processing stay with the order.",
    );
    expect(requestsSource).toContain("Unsaved customer request changes");
    expect(requestsSource).not.toContain("<UnsavedChangesGuard");
    expect(requestsSource.match(/<ContextualSaveBar/g)).toHaveLength(1);
    expect(requestsSource).toContain("isDirty={dirty}");
    expect(requestsSource).toContain("saving={saveMutation.isPending}");
    expect(requestsSource).toContain("canSave={canManage}");
    expect(requestsSource).toContain("Save policy");
  });
});
