// SSLCommerz over the SDK harness (the platform's runtime, inputs and answers
// validated against the payment port), including the transaction query the
// port asks of every hosted provider. SSLCommerz HTTP is scripted.
import { describe, expect, it } from "vitest";
import type { PaymentSessionInput } from "@scalius/plugin-sdk";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import pack, { manifest } from "./index";
import { parseCorrelationId, takaToMinor } from "./sslcommerz";

interface Call { url: URL; method: string; body: string | undefined }
type Reply = { status: number; body: string } | Error;

const SETTINGS = { sslcommerz_environment: "sandbox", sslcommerz_store_id: "store_1", sslcommerz_store_password: "secret_pw" };

function harness(reply: (call: Call) => Reply, settings: Record<string, string> = SETTINGS) {
  const calls: Call[] = [];
  const instance = createPluginTestHarness(pack, {
    settings,
    fetch: (url, init) => {
      const request = (init ?? {}) as { method?: string; body?: string };
      const call = { url: new URL(url), method: request.method ?? "GET", body: request.body };
      calls.push(call);
      const answer = reply(call);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { instance, calls };
}

const json = (body: unknown, status = 200): Reply => ({ status, body: JSON.stringify(body) });
const timeout = () => Object.assign(new Error("[http.timeout] The request timed out."), { code: "http.timeout" });
const post = (rawBody: string, query: Record<string, string> = {}) => ({ method: "POST", rawBody, headers: {}, query });

const VALIDATION = {
  status: "VALID", tran_id: "order_1_full_ABC12345", val_id: "val_1", amount: "150.00",
  currency_type: "BDT", bank_tran_id: "bank_1", value_a: "full", value_b: "order_1", card_type: "BKASH-BKash",
};
const CONFIRMED = {
  status: "event",
  event: {
    kind: "confirmed", eventType: "ipn", eventId: "order_1_full_ABC12345:val_1", orderId: "order_1",
    providerRef: "val_1", secondaryRef: "bank_1", amountMinor: 15_000, currency: "BDT", paymentType: "full",
    details: { tranId: "order_1_full_ABC12345", validationStatus: "VALID", cardType: "BKASH-BKash", cardBrand: null },
  },
};

const session = (overrides: Partial<PaymentSessionInput> = {}): PaymentSessionInput => ({
  attemptKey: "psa_attempt_1",
  correlationId: "order_1_full_ABC12345",
  orderId: "order_1",
  paymentType: "full",
  amountMinor: 15_000,
  currency: "BDT",
  wireAmount: { minor: 15_000, decimal: "150.00" },
  buyer: { name: "Rahim", phone: "+8801712345678", email: "rahim@example.com", address: "House 1", city: "Dhaka" },
  urls: {
    success: "https://api.shop.test/api/v1/payment/scalius.bangladesh:sslcommerz/success",
    fail: "https://api.shop.test/api/v1/payment/scalius.bangladesh:sslcommerz/fail",
    cancel: "https://api.shop.test/api/v1/payment/scalius.bangladesh:sslcommerz/cancel",
    webhook: "https://api.shop.test/api/v1/webhooks/scalius.bangladesh:sslcommerz",
  },
  requestTimeoutMs: 10_000,
  ...overrides,
});

describe("the Bangladesh pack's SSLCommerz declaration", () => {
  it("declares a hosted BDT gateway with SSLCommerz's limits, its own mark and settings, and the unsigned return field", () => {
    expect(manifest.providers.payment.filter((provider) => provider.id === "sslcommerz")).toEqual([expect.objectContaining({
      id: "sslcommerz",
      name: "SSLCommerz",
      checkoutName: "Online Payment",
      icon: "assets/sslcommerz.png",
      flow: "hosted",
      chargeCurrencies: ["BDT"],
      amountLimits: { currency: "BDT", minMinor: 1_000, maxMinor: 50_000_000 },
      operations: ["verifyReturn", "queryPayment", "refund", "refundStatus", "testConnection"],
      settings: ["sslcommerz_environment", "sslcommerz_store_id", "sslcommerz_store_password"],
      environmentSetting: "sslcommerz_environment",
      returnCorrelationField: "tran_id",
    })]);
    expect(manifest.features.find((entry) => entry.id === "sslcommerz")).toMatchObject({ providers: ["sslcommerz"], allowedHosts: ["sandbox.sslcommerz.com", "securepay.sslcommerz.com"] });
    // No default: activation moves a store's old sandbox/live choice into an unset setting.
    expect(manifest.settings.find((field) => field.key === "sslcommerz_environment")).not.toHaveProperty("default");
  });
});

describe("SSLCommerz sessions", () => {
  it("starts a session with the platform's reference, amount and URLs, carrying the type and order in value_a/value_b", async () => {
    const { instance, calls } = harness(() => json({ status: "SUCCESS", GatewayPageURL: "https://sandbox.sslcommerz.com/EasyCheckOut/abc", sessionkey: "SESS123" }));
    expect(await instance.provider("sslcommerz", "createSession", session())).toMatchObject({
      ok: true,
      value: { providerRef: "SESS123", redirectUrl: "https://sandbox.sslcommerz.com/EasyCheckOut/abc" },
    });
    const sent = new URLSearchParams(calls[0]!.body);
    expect(calls[0]!.url.href).toBe("https://sandbox.sslcommerz.com/gwprocess/v4/api.php");
    expect(Object.fromEntries(sent)).toMatchObject({
      store_id: "store_1", total_amount: "150.00", currency: "BDT", tran_id: "order_1_full_ABC12345",
      ipn_url: "https://api.shop.test/api/v1/webhooks/scalius.bangladesh:sslcommerz",
      success_url: "https://api.shop.test/api/v1/payment/scalius.bangladesh:sslcommerz/success",
      value_a: "full", value_b: "order_1",
    });
  });

  it("uses the live host only when the store chose live", async () => {
    const { instance, calls } = harness(
      () => json({ status: "SUCCESS", GatewayPageURL: "https://securepay.sslcommerz.com/EasyCheckOut/x", sessionkey: "S" }),
      { ...SETTINGS, sslcommerz_environment: "live" },
    );
    await instance.provider("sslcommerz", "createSession", session());
    expect(calls[0]!.url.host).toBe("securepay.sslcommerz.com");
  });

  it("reports a refusal as declined with SSLCommerz's reason, a timeout as retryable, and never a credential", async () => {
    const refused = harness(() => json({ status: "FAILED", failedreason: "Store Credential Error Or Store is De-active" }));
    const result = await refused.instance.provider("sslcommerz", "createSession", session());
    expect(result).toMatchObject({ ok: false, error: { category: "declined", message: "Store Credential Error Or Store is De-active" } });
    expect(JSON.stringify(result)).not.toContain("secret_pw");

    const slow = harness(() => timeout());
    expect(await slow.instance.provider("sslcommerz", "createSession", session())).toMatchObject({ ok: false, error: { category: "retryable" } });

    const plain = harness(() => json({ status: "SUCCESS", GatewayPageURL: "http://sandbox.sslcommerz.com/x" }));
    expect(await plain.instance.provider("sslcommerz", "createSession", session())).toMatchObject({ ok: false, error: { category: "declined" } });
  });

  it("fails closed without its store ID and password", async () => {
    const { instance, calls } = harness(() => json({}), { sslcommerz_environment: "sandbox" });
    expect(await instance.provider("sslcommerz", "createSession", session())).toMatchObject({ ok: false, error: { category: "misconfigured" } });
    expect(calls).toHaveLength(0);
  });
});

describe("SSLCommerz IPN and returns", () => {
  it("trusts an IPN only after server-to-server validation of its val_id", async () => {
    const { instance, calls } = harness(() => json(VALIDATION));
    expect(await instance.provider("sslcommerz", "verifyWebhook", post("val_id=val_1&amount=999999"))).toMatchObject({ ok: true, value: CONFIRMED });
    expect(calls[0]!.url.pathname).toBe("/validator/api/validationserverAPI.php");
    expect(calls[0]!.url.searchParams.get("val_id")).toBe("val_1");
  });

  it("asks SSLCommerz to retry when validation is unreachable and ignores unfinished or inconsistent results", async () => {
    const answers: Reply[] = [new Error("network"), json({ ...VALIDATION, status: "PENDING" }), json({ ...VALIDATION, value_b: "order_2" }), json({ ...VALIDATION, status: "FAILED" })];
    const { instance } = harness(() => answers.shift()!);
    const ipn = () => instance.provider("sslcommerz", "verifyWebhook", post("val_id=val_1"));
    expect(await ipn()).toMatchObject({ value: { status: "retry" } });
    expect(await ipn()).toMatchObject({ value: { status: "ignored" } });
    expect(await ipn()).toMatchObject({ value: { status: "ignored" } });
    expect(await ipn()).toMatchObject({ value: { status: "event", event: { kind: "failed", providerRef: "val_1" } } });
  });

  it("refuses a tampered validation: another val_id, a mismatched amount format or a foreign currency never confirm", async () => {
    const answers: Reply[] = [
      json({ ...VALIDATION, val_id: "val_2" }),
      json({ ...VALIDATION, amount: "150.005" }),
      json({ ...VALIDATION, currency_type: "USD", currency: "USD" }),
      json({ ...VALIDATION, value_a: "deposit" }),
    ];
    const { instance } = harness(() => answers.shift()!);
    const ipn = () => instance.provider("sslcommerz", "verifyWebhook", post("val_id=val_1"));
    expect(await ipn()).toMatchObject({ value: { status: "ignored" } });
    expect(await ipn()).toMatchObject({ value: { status: "retry" } });
    expect(await ipn()).toMatchObject({ value: { status: "retry" } });
    expect(await ipn()).toMatchObject({ value: { status: "ignored" } });
  });

  it("ignores an IPN without a val_id and calls nothing", async () => {
    const { instance, calls } = harness(() => json(VALIDATION));
    expect(await instance.provider("sslcommerz", "verifyWebhook", post("tran_id=order_1_full_ABC12345"))).toMatchObject({ value: { status: "ignored", reason: "IPN missing val_id" } });
    expect(calls).toHaveLength(0);
  });

  it("produces the same claim identity for a buyer return as for the IPN, and rejects a return whose context disagrees", async () => {
    const { instance } = harness(() => json(VALIDATION));
    const ipn = await instance.provider("sslcommerz", "verifyWebhook", post("val_id=val_1"));
    const buyerReturn = post("tran_id=order_1_full_ABC12345&val_id=val_1", { order_id: "order_1", payment_type: "full" });
    const returned = await instance.provider("sslcommerz", "verifyReturn", buyerReturn);
    expect(returned.value).toEqual(ipn.value);

    expect(await instance.provider("sslcommerz", "verifyReturn", { ...buyerReturn, query: { order_id: "order_1", payment_type: "deposit" } }))
      .toMatchObject({ value: { status: "ignored" } });
  });
});

describe("SSLCommerz transaction query", () => {
  it("asks by session key, then validates the payment it names into the IPN's event", async () => {
    const { instance, calls } = harness((call) => (call.url.pathname.endsWith("merchantTransIDvalidationAPI.php")
      ? json({ APIConnect: "DONE", status: "VALID", val_id: "val_1", sessionkey: "SESS123" })
      : json(VALIDATION)));
    expect(await instance.provider("sslcommerz", "queryPayment", { providerRef: "SESS123", orderId: "order_1", requestTimeoutMs: 10_000 }))
      .toMatchObject({ ok: true, value: { providerStatus: "VALID", event: CONFIRMED.event } });
    expect(calls[0]!.url.searchParams.get("sessionkey")).toBe("SESS123");
  });

  it("reports an unpaid session without an event, and never one for another order", async () => {
    const pending = harness(() => json({ APIConnect: "DONE", status: "PENDING" }));
    expect(await pending.instance.provider("sslcommerz", "queryPayment", { providerRef: "SESS123", orderId: "order_1", requestTimeoutMs: 10_000 }))
      .toEqual(expect.objectContaining({ ok: true, value: { providerStatus: "PENDING" } }));

    const other = harness((call) => (call.url.pathname.endsWith("merchantTransIDvalidationAPI.php")
      ? json({ APIConnect: "DONE", status: "VALID", val_id: "val_1" })
      : json(VALIDATION)));
    expect(await other.instance.provider("sslcommerz", "queryPayment", { providerRef: "SESS123", orderId: "order_9", requestTimeoutMs: 10_000 }))
      .toEqual(expect.objectContaining({ ok: true, value: { providerStatus: "VALID" } }));
  });
});

describe("SSLCommerz refunds", () => {
  const refundInput = {
    providerRef: "val_1", secondaryRef: "bank_1", amountMinor: 5_000, currency: "BDT", wireAmount: { minor: 5_000, decimal: "50.00" },
    reason: "Customer request", idempotencyKey: "rfa_1", reference: "RF-order_1-1", metadata: {},
  };

  it("refunds against the bank transaction with a deterministic refund reference", async () => {
    const { instance, calls } = harness(() => json({ APIConnect: "DONE", status: "success", refund_ref_id: "REF123" }));
    expect(await instance.provider("sslcommerz", "refund", refundInput)).toMatchObject({ ok: true, value: { refundId: "REF123" } });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({
      bank_tran_id: "bank_1", refund_amount: "50.00", refund_trans_id: "RForder11", refund_remarks: "Customer request",
    });
  });

  it("keeps a refused or unanswered refund for reconciliation, never resent, and refuses one without a bank reference", async () => {
    const refused = harness(() => json({ APIConnect: "DONE", status: "failed", errorReason: "Insufficient balance" }));
    expect(await refused.instance.provider("sslcommerz", "refund", refundInput)).toMatchObject({ ok: false, error: { category: "retryable", uncertain: true } });
    const lost = harness(() => timeout());
    expect(await lost.instance.provider("sslcommerz", "refund", refundInput)).toMatchObject({ ok: false, error: { category: "retryable", uncertain: true } });
    const missing = harness(() => json({}));
    expect(await missing.instance.provider("sslcommerz", "refund", { ...refundInput, secondaryRef: null }))
      .toMatchObject({ ok: false, error: { category: "declined", uncertain: false } });
    expect(missing.calls).toHaveLength(0);
  });

  it("maps a refund's status to accepted, rejected or still processing", async () => {
    const probe = { providerRefundId: "REF123", sourceRef: "bank_1", amountMinor: 5_000, currency: "BDT", reference: "RF-order_1-1", idempotencyKey: "rfa_1" };
    for (const [status, outcome] of [["refunded", "accepted"], ["cancelled", "rejected"], ["processing", "processing"]] as const) {
      const { instance } = harness(() => json({ APIConnect: "DONE", status, refund_ref_id: "REF123", bank_tran_id: "bank_1", tran_id: "t" }));
      expect(await instance.provider("sslcommerz", "refundStatus", probe)).toMatchObject({ ok: true, value: { outcome, providerRefundId: "REF123" } });
    }
    const noRef = harness(() => json({}));
    expect(await noRef.instance.provider("sslcommerz", "refundStatus", { ...probe, providerRefundId: null }))
      .toMatchObject({ ok: true, value: { outcome: "unknown", manualReview: true } });
  });
});

describe("SSLCommerz connection test and amounts", () => {
  it("passes only when SSLCommerz takes the store's credentials", async () => {
    const good = harness(() => json({ APIConnect: "DONE", no_of_trans_found: 0 }));
    expect(await good.instance.provider("sslcommerz", "testConnection", {})).toMatchObject({ ok: true, value: { ok: true, message: "Connected to SSLCommerz sandbox." } });
    const bad = harness(() => json({ APIConnect: "FAILED" }));
    expect(await bad.instance.provider("sslcommerz", "testConnection", {})).toMatchObject({ ok: true, value: { ok: false } });
  });

  it("reads taka exactly and the platform's correlation ids as context only", () => {
    expect(takaToMinor("150.00")).toBe(15_000);
    expect(takaToMinor("150.5")).toBe(15_050);
    expect(takaToMinor("150")).toBe(15_000);
    expect(takaToMinor("150.505")).toBeNull();
    expect(takaToMinor("-1")).toBeNull();
    expect(parseCorrelationId("order_1_full_ABC12345")).toEqual({ orderId: "order_1", paymentType: "full" });
    expect(parseCorrelationId("01K2V8X7M4P3N6QT_DABC12345")).toEqual({ orderId: "01K2V8X7M4P3N6QT", paymentType: "deposit" });
  });
});
