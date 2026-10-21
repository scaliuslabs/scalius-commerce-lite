// @vitest-environment node
// Account → Profile → Saved payment methods: the list and the removal go
// through the account API with the session cookie only; the remove form's
// method id is read from the POST body; the outcome comes back as a flag in
// the URL, never an id, a brand or digits.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api/transport", () => ({
  resolveBackendTarget: (path: string) => ({
    url: `https://api.internal${path}`,
    fetch: api.fetch,
    viaServiceBinding: true,
  }),
}));

import {
  accountPaymentMethodLocation,
  paymentMethodBrand,
  paymentMethodEnding,
  paymentMethodExpiry,
  paymentMethodSavedFor,
  readAccountPaymentMethodFlag,
  readAccountPaymentMethodForm,
} from "./account-payment-methods";
import { readAccountPaymentMethods, removeAccountPaymentMethod } from "./account-server";

const SESSION = "cs_tok=session-token-value";
const signedIn = () => new Request("https://shop.example.test/account/profile", { method: "POST", headers: { Cookie: SESSION } });
const METHOD = {
  id: "cpm_1", brand: "visa", last4: "4242", expiryMonth: 8, expiryYear: 2027, label: null,
  savedFor: "Subscribe and save", createdAt: "2026-10-01T04:00:00.000Z",
};

function answer(status: number, body: unknown) {
  api.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => api.fetch.mockReset());

describe("account saved payment methods", () => {
  it("reads the list with the session cookie and keeps only the display facts", async () => {
    answer(200, { success: true, data: { paymentMethods: [{ ...METHOD, providerMethodRef: "pm_secret" }, { brand: "visa" }] } });
    const read = await readAccountPaymentMethods(signedIn());
    expect(read).toEqual({ ok: true, data: [METHOD] });
    const [url, init] = api.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.internal/api/v1/customer-auth/payment-methods");
    expect(new Headers(init.headers).get("Cookie")).toBe(SESSION);
  });

  it("reads signed out without a session, and unavailable when the API fails", async () => {
    expect(await readAccountPaymentMethods(new Request("https://shop.example.test/account/profile"))).toEqual({ ok: false, reason: "signed_out" });
    expect(api.fetch).not.toHaveBeenCalled();
    answer(500, { success: false });
    expect(await readAccountPaymentMethods(signedIn())).toEqual({ ok: false, reason: "unavailable" });
  });

  it("removes one by DELETE and tells a refusal from an outage", async () => {
    answer(200, { success: true, data: { paymentMethods: [] } });
    expect(await removeAccountPaymentMethod(signedIn(), "cpm_1")).toEqual({ ok: true, paymentMethods: [] });
    const [url, init] = api.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.internal/api/v1/customer-auth/payment-methods/cpm_1");
    expect(init.method).toBe("DELETE");

    answer(404, { success: false, error: { message: "Saved payment method not found" } });
    expect(await removeAccountPaymentMethod(signedIn(), "cpm_x")).toEqual({ ok: false, reason: "refused" });
    answer(503, { success: false });
    expect(await removeAccountPaymentMethod(signedIn(), "cpm_1")).toEqual({ ok: false, reason: "unavailable" });
    answer(401, { success: false });
    expect(await removeAccountPaymentMethod(signedIn(), "cpm_1")).toEqual({ ok: false, reason: "signed_out" });
  });

  it("reads the method id from the form and refuses anything that is not an id", () => {
    const form = (id: string) => {
      const data = new FormData();
      data.set("methodId", id);
      return data;
    };
    expect(readAccountPaymentMethodForm(form("cpm_0a1b"))).toBe("cpm_0a1b");
    expect(readAccountPaymentMethodForm(form("../orders"))).toBeNull();
    expect(readAccountPaymentMethodForm(new FormData())).toBeNull();
  });

  it("lands back with only an outcome flag", () => {
    expect(accountPaymentMethodLocation("removed")).toBe("/account/profile?paymentMethod=removed#payment-methods");
    expect(readAccountPaymentMethodFlag(new URLSearchParams("paymentMethod=removed"))).toBe("removed");
    expect(readAccountPaymentMethodFlag(new URLSearchParams("paymentMethod=cpm_1"))).toBeNull();
  });

  it("names the card as it prints, and says when it has expired", () => {
    expect(paymentMethodBrand({ brand: "visa", label: null })).toBe("Visa");
    expect(paymentMethodBrand({ brand: "American Express", label: null })).toBe("American Express");
    expect(paymentMethodBrand({ brand: "weird-network", label: null })).toBe("Card");
    expect(paymentMethodBrand({ brand: "wallet", label: "Pay Wallet" })).toBe("Pay Wallet");
    expect(paymentMethodBrand({ brand: null, label: null })).toBe("Card");
    expect(paymentMethodEnding("4242")).toBe("ending in 4242");
    expect(paymentMethodEnding("42")).toBeNull();
    const now = new Date("2026-10-21T00:00:00Z");
    expect(paymentMethodExpiry({ expiryMonth: 10, expiryYear: 2026 }, now)).toEqual({ text: "Expires 10/26", expired: false });
    expect(paymentMethodExpiry({ expiryMonth: 9, expiryYear: 2026 }, now)).toEqual({ text: "Expired 09/26", expired: true });
    expect(paymentMethodExpiry({ expiryMonth: null, expiryYear: 2026 }, now)).toBeNull();
    expect(paymentMethodSavedFor("Subscribe and save")).toBe("Saved for Subscribe and save");
    expect(paymentMethodSavedFor("  ")).toBeNull();
  });
});
