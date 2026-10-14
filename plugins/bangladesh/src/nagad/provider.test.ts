// The pack's Nagad feature end to end through the SDK's harness (the platform's runtime
// over an in-memory bridge) against MockNagad, which really decrypts and
// signature-checks every request and seals its answers.

import { beforeAll, describe, expect, it } from "vitest";
import type { PaymentEvent, PaymentSessionInput } from "@scalius/plugin-sdk";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import nagadPlugin from "../index";
import {
  BUYER_MOBILE,
  generateKeyPair,
  LIVE_BASE,
  MERCHANT_ID,
  MERCHANT_NUMBER,
  MockNagad,
  SANDBOX_BASE,
  type KeyPair,
} from "./mock-nagad";

let merchant: KeyPair;
let nagad: KeyPair;

beforeAll(async () => {
  [merchant, nagad] = await Promise.all([generateKeyPair(), generateKeyPair()]);
});

const SUCCESS_URL = "https://api.shop.test/api/v1/payment/scalius.bangladesh:nagad/success?order_id=ORD1&payment_type=full";
const CORRELATION_ID = "ORD1_full_ABC12345";

async function setup(settings: Record<string, string> = {}) {
  const server = await MockNagad.create(nagad, merchant);
  const harness = createPluginTestHarness(nagadPlugin, {
    settings: {
      nagad_merchant_id: MERCHANT_ID,
      nagad_merchant_number: MERCHANT_NUMBER,
      nagad_merchant_private_key: merchant.privatePem,
      nagad_public_key: nagad.publicPem,
      ...settings,
    },
    fetch: server.fetch,
    features: ["nagad"],
  });
  return { server, harness };
}

type Harness = Awaited<ReturnType<typeof setup>>["harness"];

function sessionInput(overrides: Partial<PaymentSessionInput> = {}): PaymentSessionInput {
  return {
    attemptKey: "payment_session:scalius.bangladesh:nagad:4f2a9c",
    correlationId: CORRELATION_ID,
    orderId: "ORD1",
    paymentType: "full",
    amountMinor: 12_550,
    currency: "BDT",
    wireAmount: { minor: 12_550, decimal: "125.50" },
    buyer: { name: "Buyer", phone: `+88${BUYER_MOBILE}` },
    urls: {
      success: SUCCESS_URL,
      fail: "https://api.shop.test/api/v1/payment/scalius.bangladesh:nagad/fail?order_id=ORD1",
      cancel: "https://api.shop.test/api/v1/payment/scalius.bangladesh:nagad/cancel?order_id=ORD1",
      webhook: "https://api.shop.test/api/v1/webhooks/scalius.bangladesh:nagad",
    },
    requestTimeoutMs: 11_000,
    ...overrides,
  };
}

async function startSession(harness: Harness, input = sessionInput()): Promise<{ providerRef: string; redirectUrl: string }> {
  const result = await harness.provider("nagad", "createSession", input);
  expect(result.error).toBeNull();
  return result.value as { providerRef: string; redirectUrl: string };
}

/** The buyer coming back from Nagad: the platform's own query plus what Nagad appends (never trusted). */
function buyerReturn(reference: string, status = "Success") {
  return {
    method: "GET",
    rawBody: "",
    headers: {},
    query: {
      order_id: "ORD1",
      payment_type: "full",
      merchant: MERCHANT_ID,
      payment_ref_id: reference,
      status,
      status_code: "00_0000_000",
      message: "Successful Transaction",
    },
  };
}

function query(reference: string, orderId = "ORD1") {
  return { providerRef: reference, orderId, requestTimeoutMs: 5_000 };
}

describe("the Nagad feature", () => {
  it("is labelled unverified and declares a hosted BDT provider without refunds, reaching only Nagad", async () => {
    const { harness } = await setup();
    expect(harness.manifest.features.find((entry) => entry.id === "nagad")?.name).toBe("Nagad (unverified)");
    expect(harness.manifest.allowedHosts).toEqual(["api.mynagad.com", "sandbox-ssl.mynagad.com:10061"]);
    expect(harness.manifest.providers).toEqual([expect.objectContaining({
      kind: "payment",
      id: "nagad",
      name: "Nagad (unverified)",
      flow: "hosted",
      chargeCurrencies: ["BDT"],
      operations: ["verifyReturn", "queryPayment", "testConnection"],
    })]);
  });
});

describe("createSession", () => {
  it("initializes and completes with Nagad's headers, paths and sealed payloads, then sends the buyer to Nagad", async () => {
    const { server, harness } = await setup();
    const session = await startSession(harness);

    expect(server.calls.map((call) => call.step)).toEqual(["initialize", "complete"]);
    const [initialize, complete] = server.calls;
    for (const call of server.calls) {
      expect(call.method).toBe("POST");
      expect(call.headers).toEqual({
        "Content-Type": "application/json",
        "X-KM-Api-Version": "v-0.2.0",
        "X-KM-IP-V4": "127.0.0.1",
        "X-KM-Client-Type": "PC_WEB",
      });
    }
    const nagadOrderId = String(initialize?.sensitive?.orderId);
    expect(nagadOrderId).toMatch(/^[0-9a-f]{20}$/);
    expect(initialize?.url).toBe(`${SANDBOX_BASE}/check-out/initialize/${MERCHANT_ID}/${nagadOrderId}?locale=EN`);
    expect(initialize?.body).toEqual({
      accountNumber: MERCHANT_NUMBER,
      dateTime: expect.stringMatching(/^\d{14}$/),
      sensitiveData: expect.any(String),
      signature: expect.any(String),
    });
    // The mock opened this with Nagad's private key and checked the merchant's signature over it.
    expect(Object.keys(initialize?.sensitive ?? {})).toEqual(["merchantId", "datetime", "orderId", "challenge"]);
    expect(initialize?.sensitive).toMatchObject({ merchantId: MERCHANT_ID, datetime: initialize?.body?.dateTime });

    expect(complete?.url).toBe(`${SANDBOX_BASE}/check-out/complete/${encodeURIComponent(session.providerRef)}`);
    expect(complete?.sensitive).toEqual({
      merchantId: MERCHANT_ID,
      orderId: nagadOrderId,
      currencyCode: "050",
      amount: "125.50",
      challenge: initialize?.sensitive?.challenge,
    });
    expect(complete?.body).toMatchObject({ merchantCallbackURL: SUCCESS_URL, additionalMerchantInfo: {} });

    expect(session.providerRef).toMatch(/^\+\+\/\//);
    expect(server.payments.has(session.providerRef)).toBe(true);
    expect(session.redirectUrl).toBe(`https://sandbox-ssl.mynagad.com:10061/check-out/pay/${encodeURIComponent(session.providerRef)}`);
  });

  it("replays the same session for a retry of the same attempt, and gives another attempt its own Nagad order", async () => {
    const { server, harness } = await setup();
    const first = await startSession(harness);
    expect(await startSession(harness)).toEqual(first);
    expect(server.calls).toHaveLength(2);

    const other = await startSession(harness, sessionInput({ attemptKey: "payment_session:scalius.bangladesh:nagad:77aa01" }));
    expect(other.providerRef).not.toBe(first.providerRef);
    const orderIds = server.callsOf("initialize").map((call) => call.sensitive?.orderId);
    expect(new Set(orderIds).size).toBe(2);
  });

  it("uses the live API and the configured server IP", async () => {
    const { server, harness } = await setup({ nagad_environment: "live", nagad_server_ip: "203.0.113.10" });
    await startSession(harness);
    expect(server.calls[0]?.url.startsWith(`${LIVE_BASE}/check-out/initialize/${MERCHANT_ID}/`)).toBe(true);
    expect(server.calls[0]?.headers["X-KM-IP-V4"]).toBe("203.0.113.10");
  });

  it("refuses an answer Nagad did not sign or that lacks this request's challenge, then starts afresh", async () => {
    const { server, harness } = await setup();
    server.faults.initialize = "bad_signature";
    const unsigned = await harness.provider("nagad", "createSession", sessionInput());
    expect(unsigned.error).toMatchObject({ category: "misconfigured", code: "nagad.bad_signature", uncertain: false });

    server.faults.initialize = "wrong_challenge";
    const replayed = await harness.provider("nagad", "createSession", sessionInput());
    expect(replayed.error).toMatchObject({ category: "misconfigured", code: "nagad.challenge_mismatch", uncertain: false });
    expect(server.callsOf("complete")).toHaveLength(0);

    // Each refused answer left its Nagad order behind: the retry never reuses an order id.
    await startSession(harness);
    const orderIds = server.callsOf("initialize").map((call) => call.sensitive?.orderId);
    expect(new Set(orderIds).size).toBe(3);
  });

  it("is retryable and uncertain when a request may have reached Nagad, and resumes the same Nagad order", async () => {
    const { server, harness } = await setup();
    server.faults.initialize = "timeout";
    const lostInitialize = await harness.provider("nagad", "createSession", sessionInput());
    expect(lostInitialize.error).toMatchObject({ category: "retryable", uncertain: true, code: "nagad.timeout" });

    server.faults.complete = "timeout";
    const lostComplete = await harness.provider("nagad", "createSession", sessionInput());
    expect(lostComplete.error).toMatchObject({ category: "retryable", uncertain: true, code: "nagad.timeout" });

    // Initialize went through the second time: the retry only completes that order.
    const session = await startSession(harness);
    expect(server.callsOf("initialize")).toHaveLength(2);
    const completes = server.callsOf("complete");
    expect(completes).toHaveLength(2);
    expect(completes[1]?.url).toBe(completes[0]?.url);
    expect(server.payments.has(session.providerRef)).toBe(true);

    for (const fault of ["unreachable", "server_error"] as const) {
      const fresh = await setup();
      fresh.server.faults.initialize = fault;
      const result = await fresh.harness.provider("nagad", "createSession", sessionInput());
      expect(result.error).toMatchObject({ category: "retryable", uncertain: true, code: fault === "unreachable" ? "nagad.unreachable" : "nagad.server_error" });
    }
  });

  it("treats a refusal as final, keeps Nagad's reason code but never its message, and starts a new order next time", async () => {
    const { server, harness } = await setup();
    server.faults.complete = "decline";
    const declined = await harness.provider("nagad", "createSession", sessionInput());
    expect(declined.error).toMatchObject({ category: "declined", code: "nagad.transaction_limit", uncertain: false });
    expect(declined.error?.message).not.toContain(BUYER_MOBILE);

    const session = await startSession(harness);
    expect(server.callsOf("initialize")).toHaveLength(2);
    expect(server.payments.has(session.providerRef)).toBe(true);

    server.faults.initialize = "reject_signature";
    const rejected = await harness.provider("nagad", "createSession", sessionInput({ attemptKey: "payment_session:scalius.bangladesh:nagad:99" }));
    expect(rejected.error).toMatchObject({ category: "misconfigured", code: "nagad.invalid_signature" });
  });

  it("charges only BDT", async () => {
    const { server, harness } = await setup();
    const result = await harness.provider("nagad", "createSession", sessionInput({ currency: "USD" }));
    expect(result.error).toMatchObject({ category: "declined", code: "nagad.currency" });
    expect(server.calls).toHaveLength(0);
  });
});

describe("buyer returns and status queries", () => {
  it("confirms a return only through Nagad's Verify, in exact paisa, and the same capture is the same event everywhere", async () => {
    const { server, harness } = await setup();
    const session = await startSession(harness);
    server.settle(session.providerRef, "Success", "7XK9ABC1");

    const result = await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef));
    expect(result.value).toEqual({
      status: "event",
      event: {
        kind: "confirmed",
        eventType: "nagad.payment",
        eventId: "7XK9ABC1",
        orderId: "ORD1",
        providerRef: session.providerRef,
        secondaryRef: "7XK9ABC1",
        amountMinor: 12_550,
        currency: "BDT",
        details: { nagadOrderId: expect.stringMatching(/^[0-9a-f]{20}$/), status: "Success", statusCode: "000" },
      },
    });
    const verify = server.callsOf("verify")[0];
    expect(verify?.method).toBe("GET");
    expect(verify?.url).toBe(`${SANDBOX_BASE}/verify/payment/${encodeURIComponent(session.providerRef)}`);
    expect(JSON.stringify(result)).not.toContain(BUYER_MOBILE);
    expect(JSON.stringify(result)).not.toContain(MERCHANT_NUMBER);

    const duplicate = await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef));
    expect(duplicate.value).toEqual(result.value);
    const status = await harness.provider("nagad", "queryPayment", query(session.providerRef));
    expect(status.value).toEqual({ providerStatus: "Success", event: (result.value as { event: PaymentEvent }).event });
  });

  it("accepts Nagad's amount as a JSON number, and a reference whose '+' arrived as a space", async () => {
    const { server, harness } = await setup();
    const session = await startSession(harness);
    server.settle(session.providerRef, "Success", "7XK9ABC2");
    server.verifyOverrides = { amount: 125.5 };
    const result = await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef.replace(/\+/g, " ")));
    expect(result.value).toMatchObject({ status: "event", event: { kind: "confirmed", amountMinor: 12_550, providerRef: session.providerRef } });
  });

  it("never trusts the return's own status: a payment Nagad has not finished is ignored", async () => {
    const { harness } = await setup();
    const session = await startSession(harness);
    const result = await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef, "Success"));
    expect(result.value).toEqual({ status: "ignored", reason: "Nagad reports the payment as Ready; it is not final yet." });
    const status = await harness.provider("nagad", "queryPayment", query(session.providerRef));
    expect(status.value).toEqual({ providerStatus: "Ready" });
  });

  it("releases the attempt by its correlation id when Nagad says aborted, cancelled or failed, and the next try starts a new order", async () => {
    const cases = [["Aborted", "cancelled"], ["Cancelled", "cancelled"], ["Failed", "failed"]] as const;
    for (const [nagadStatus, kind] of cases) {
      const { server, harness } = await setup();
      const session = await startSession(harness);
      server.settle(session.providerRef, nagadStatus);
      const result = await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef, nagadStatus));
      expect(result.value, nagadStatus).toEqual({
        status: "event",
        event: {
          kind,
          eventType: "nagad.payment",
          eventId: `${session.providerRef}:${kind}`,
          orderId: "ORD1",
          providerRef: session.providerRef,
          correlationId: CORRELATION_ID,
          details: { nagadOrderId: expect.stringMatching(/^[0-9a-f]{20}$/), status: nagadStatus, statusCode: "001" },
        },
      });
      // A query reports the status; only a capture is an event there.
      expect((await harness.provider("nagad", "queryPayment", query(session.providerRef))).value).toEqual({ providerStatus: nagadStatus });

      const retried = await startSession(harness);
      expect(retried.providerRef).not.toBe(session.providerRef);
      expect(server.callsOf("initialize")).toHaveLength(2);
    }
  });

  it("calls a return that matches no payment of this store invalid, without asking Nagad", async () => {
    const elsewhere = await setup();
    const foreign = await startSession(elsewhere.harness);
    elsewhere.server.settle(foreign.providerRef, "Success", "7XK9ABC3");

    const { server, harness } = await setup();
    const forged = await harness.provider("nagad", "verifyReturn", buyerReturn(foreign.providerRef));
    expect(forged.value).toEqual({ status: "invalid", reason: "The return matches no Nagad payment this store started." });
    const bare = await harness.provider("nagad", "verifyReturn", { ...buyerReturn(""), query: { status: "Success" } });
    expect(bare.value).toEqual({ status: "invalid", reason: "The return carries no Nagad payment reference." });
    expect(server.calls).toHaveLength(0);

    const unknown = await harness.provider("nagad", "queryPayment", query(foreign.providerRef));
    expect(unknown.error).toMatchObject({ category: "declined", code: "nagad.unknown_payment" });
  });

  it("answers retry when Nagad cannot be reached, and a query fails retryable without uncertainty", async () => {
    const { server, harness } = await setup();
    const session = await startSession(harness);
    for (const fault of ["unreachable", "timeout", "server_error"] as const) {
      server.faults.verify = fault;
      const result = await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef));
      expect(result.value, fault).toEqual({ status: "retry", reason: "Nagad could not be reached to verify the payment." });
    }
    server.faults.verify = "timeout";
    const status = await harness.provider("nagad", "queryPayment", query(session.providerRef));
    expect(status.error).toMatchObject({ category: "retryable", uncertain: false, code: "nagad.timeout" });
  });

  it("refuses a capture whose amount, order or merchant differ from what this store created", async () => {
    const { server, harness } = await setup();
    const session = await startSession(harness);
    server.settle(session.providerRef, "Success", "7XK9ABC4");
    const mismatches = [
      [{ amount: "1.00" }, "Nagad reports a different amount than this payment."],
      [{ amount: null }, "Nagad reports a different amount than this payment."],
      [{ orderId: "0123456789abcdef0123" }, "Nagad's answer is for a different payment."],
      [{ paymentRefId: "AAAA" }, "Nagad's answer is for a different payment."],
      [{ merchantId: "683002007100000" }, "Nagad's answer is for a different merchant."],
    ] as const;
    for (const [overrides, reason] of mismatches) {
      server.verifyOverrides = { ...overrides };
      const result = await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef));
      expect(result.value, reason).toEqual({ status: "invalid", reason });
      const status = await harness.provider("nagad", "queryPayment", query(session.providerRef));
      expect(status.error, reason).toMatchObject({ category: "declined", code: "nagad.payment_mismatch" });
    }
    const otherOrder = await harness.provider("nagad", "queryPayment", query(session.providerRef, "ORD2"));
    expect(otherOrder.error).toMatchObject({ category: "declined", code: "nagad.unknown_payment" });
  });
});

describe("testConnection and webhooks", () => {
  it("checks the settings locally and says it cannot reach Nagad without a real payment", async () => {
    const { server, harness } = await setup();
    const result = await harness.provider("nagad", "testConnection", {});
    expect(result.value).toEqual({ ok: true, message: expect.stringMatching(/\(sandbox\).*only a real payment proves the connection/) });
    expect(server.calls).toHaveLength(0);
  });

  it("names the wrong setting without echoing any key", async () => {
    const keyLine = merchant.privatePem.split("\n")[1] ?? "";
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ nagad_merchant_id: "" }, /merchant ID/],
      [{ nagad_merchant_private_key: "" }, /Paste your merchant private key/],
      [{ nagad_merchant_private_key: merchant.privatePem.replace(/PRIVATE KEY/g, "RSA PRIVATE KEY") }, /PKCS#1 key\. Convert it with: openssl pkcs8/],
      [{ nagad_merchant_private_key: merchant.publicPem }, /merchant private key is not a readable RSA private key/],
      [{ nagad_public_key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A" }, /Nagad public key is not a readable RSA public key/],
      [{ nagad_public_key: merchant.publicPem }, /holds your own public key/],
      [{ nagad_server_ip: "localhost" }, /IPv4/],
      [{ nagad_merchant_number: "12345" }, /merchant number/],
      [{ nagad_environment: "staging" }, /sandbox or live/],
    ];
    for (const [settings, message] of cases) {
      const { harness } = await setup(settings);
      const result = await harness.provider("nagad", "testConnection", {});
      expect(result.value, JSON.stringify(Object.keys(settings))).toEqual({ ok: false, message: expect.stringMatching(message) });
      expect(JSON.stringify(result)).not.toContain(keyLine);
    }
  });

  it("ignores webhooks: Nagad's flow has none", async () => {
    const { harness } = await setup();
    const result = await harness.provider("nagad", "verifyWebhook", { method: "POST", rawBody: "{}", headers: {}, query: {} });
    expect(result.value).toMatchObject({ status: "ignored" });
  });
});

describe("secrets and buyer data", () => {
  it("never puts a key, a signature, sensitiveData or a mobile number in an answer, an error or a log", async () => {
    const { server, harness } = await setup();
    const results: unknown[] = [];
    server.faults.complete = "decline";
    results.push(await harness.provider("nagad", "createSession", sessionInput()));
    server.faults.initialize = "bad_signature";
    results.push(await harness.provider("nagad", "createSession", sessionInput()));
    const session = await startSession(harness);
    server.settle(session.providerRef, "Success", "7XK9ABC5");
    results.push(await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef)));
    server.verifyOverrides = { amount: "1.00" };
    results.push(await harness.provider("nagad", "verifyReturn", buyerReturn(session.providerRef)));
    results.push(await harness.provider("nagad", "queryPayment", query(session.providerRef)));

    const sealed = server.calls.flatMap((call) => [call.body?.sensitiveData, call.body?.signature]).filter((value) => typeof value === "string");
    const secrets = [
      BUYER_MOBILE,
      MERCHANT_NUMBER,
      ...merchant.privatePem.split("\n").filter((line) => line.length === 64),
      ...sealed.map((value) => String(value).slice(0, 40)),
    ];
    expect(harness.logs.length).toBeGreaterThan(0);
    const visible = JSON.stringify([results, harness.logs]);
    for (const secret of secrets) expect(visible).not.toContain(secret);
  });
});
