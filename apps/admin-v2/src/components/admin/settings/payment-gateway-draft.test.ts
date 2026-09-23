import { describe, expect, it } from "vitest";
import {
  sslCommerzDraftIsDirty,
  stripeDraftIsDirty,
} from "./payment-gateway-draft";

describe("payment gateway draft boundaries", () => {
  it("treats an unloaded gateway as dirty-unknown rather than a saved empty form", () => {
    expect(stripeDraftIsDirty({ secretKey: "", publishableKey: "", webhookSecret: "", enabled: false }, null)).toBe(true);
  });

  it("tracks every Stripe provider, environment, and credential field", () => {
    const saved = { secretKey: "••••••••••••", publishableKey: "pk_test_saved", webhookSecret: "••••••••••••", enabled: false };
    expect(stripeDraftIsDirty(saved, saved)).toBe(false);
    expect(stripeDraftIsDirty({ ...saved, enabled: true }, saved)).toBe(true);
    expect(stripeDraftIsDirty({ ...saved, publishableKey: "pk_live_changed" }, saved)).toBe(true);
  });

  it("tracks SSLCommerz sandbox/provider/setup fields", () => {
    const ssl = { storeId: "store", storePassword: "••••••••••••", sandbox: true, enabled: true };

    expect(sslCommerzDraftIsDirty(ssl, ssl)).toBe(false);
    expect(sslCommerzDraftIsDirty({ ...ssl, sandbox: false }, ssl)).toBe(true);
  });
});
