// The pack's bKash feature over the SDK harness (the platform's runtime, inputs and
// answers validated against the payment port) and a small simulation of
// bKash's Tokenized Checkout API: payments are created Initiated, complete
// only on Execute after the buyer authorised them, and refunds are kept per
// payment. Individual answers can be scripted to replace the simulation.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import bkash from "../index";

const BASES = {
  sandbox: "https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/",
  live: "https://tokenized.pay.bka.sh/v1.2.0-beta/tokenized/checkout/",
} as const;
const APP_KEY = "app-key-4f1c";
const USERNAME = "sandboxTokenizedUser02";
const APP_SECRET = "app-secret-7Qk2xP9rLm3v";
const PASSWORD = "pw-Zx8c!vB4n";
const ID_TOKEN = "eyJraWQiOiJ0b2tlbi1zZWNyZXQifQ.id-token-body";
const BUYER_WALLET = "01770618575";
const SECRETS = [APP_SECRET, PASSWORD, ID_TOKEN, BUYER_WALLET];

type Json = Record<string, unknown>;
/** A scripted answer, a thrown platform error, or "lost": bKash acts on the request but its answer times out. */
type Reply = { status?: number; body: Json | string } | Error | "lost";
interface Call { environment: string; path: string; headers: Record<string, string>; body: Json; timeoutMs: number }
interface FakePayment { amount: string; invoice: string; status: string; trxID: string | null; authorized: boolean }

const fail = (statusCode: string, statusMessage: string): Reply => ({ body: { statusCode, statusMessage } });
const timeout = () => new Error("[http.timeout] The request timed out.");

class FakeBkash {
  readonly calls: Call[] = [];
  readonly payments = new Map<string, FakePayment>();
  /** The last refund of each payment (what bKash's refund status reports). */
  readonly refunds = new Map<string, Json>();
  private readonly scripted = new Map<string, Reply[]>();
  private sequence = 0;

  /** Answers the next calls to `path` with these replies instead of the simulation. */
  script(path: string, ...replies: Reply[]): void {
    this.scripted.set(path, [...(this.scripted.get(path) ?? []), ...replies]);
  }

  /** The buyer entered their PIN on bKash's page: Execute will now complete the payment. */
  authorize(paymentID: string): void {
    this.payments.get(paymentID)!.authorized = true;
  }

  paths(): string[] {
    return this.calls.map((call) => call.path);
  }

  readonly fetch = (url: string, init: unknown) => {
    const [environment, base] = Object.entries(BASES).find(([, prefix]) => url.startsWith(prefix)) ?? ["unknown", ""];
    const request = init as { method: string; headers: Record<string, string>; body: string; timeoutMs: number };
    expect(request.method).toBe("POST");
    const call = { environment, path: url.slice(base.length), headers: request.headers, body: JSON.parse(request.body) as Json, timeoutMs: request.timeoutMs };
    this.calls.push(call);
    let reply = this.scripted.get(call.path)?.shift() ?? this.simulate(call.path, call.body);
    if (reply === "lost") {
      this.simulate(call.path, call.body);
      reply = timeout();
    }
    if (reply instanceof Error) throw reply;
    return { status: reply.status ?? 200, body: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body) };
  };

  private simulate(path: string, body: Json): Reply {
    const paymentID = String(body.paymentID);
    const payment = this.payments.get(paymentID);
    switch (path) {
      case "token/grant":
        return { body: { statusCode: "0000", statusMessage: "Successful", id_token: ID_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh" } };
      case "create": {
        const id = `TR0011${(this.sequence += 1)}A`;
        this.payments.set(id, { amount: String(body.amount), invoice: String(body.merchantInvoiceNumber), status: "Initiated", trxID: null, authorized: false });
        return {
          body: {
            statusCode: "0000", statusMessage: "Successful", paymentID: id, bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${id}`,
            callbackURL: body.callbackURL, transactionStatus: "Initiated", amount: body.amount, currency: "BDT", intent: "sale",
            merchantInvoiceNumber: body.merchantInvoiceNumber,
          },
        };
      }
      case "execute":
        if (!payment) return fail("2002", "Invalid Payment ID");
        if (payment.status === "Completed") return fail("2062", "The payment has already been completed");
        if (!payment.authorized) return fail("2056", "Invalid Payment State");
        payment.status = "Completed";
        payment.trxID = `TRX${(this.sequence += 1)}B`;
        return { body: { ...this.record(paymentID, payment), paymentExecuteTime: "2026-10-03T12:00:00:000 GMT+0600" } };
      case "payment/status":
        return payment ? { body: this.record(paymentID, payment) } : fail("2002", "Invalid Payment ID");
      case "payment/refund": {
        if (!payment?.trxID || payment.trxID !== body.trxID) return fail("2033", "Transaction not found");
        if (body.amount === undefined) return this.refunds.has(paymentID) ? { body: this.refunds.get(paymentID)! } : fail("2033", "Transaction not found");
        const refunded = { originalTrxID: payment.trxID, refundTrxID: `RTX${(this.sequence += 1)}C`, transactionStatus: "Completed", amount: body.amount, currency: "BDT", charge: "0.00", completedTime: "2026-10-03T13:00:00:000 GMT+0600" };
        this.refunds.set(paymentID, refunded);
        return { body: refunded };
      }
      default:
        return { status: 404, body: "Not found" };
    }
  }

  private record(paymentID: string, payment: FakePayment): Json {
    return {
      statusCode: "0000", statusMessage: "Successful", paymentID, mode: "0011", payerReference: BUYER_WALLET,
      ...(payment.trxID ? { trxID: payment.trxID } : {}), transactionStatus: payment.status, amount: payment.amount,
      currency: "BDT", intent: "sale", merchantInvoiceNumber: payment.invoice, customerMsisdn: BUYER_WALLET,
    };
  }
}

const settings = { bkash_environment: "sandbox", bkash_app_key: APP_KEY, bkash_app_secret: APP_SECRET, bkash_username: USERNAME, bkash_password: PASSWORD };

function setup(overrides: Record<string, string> = {}) {
  const bank = new FakeBkash();
  const harness = createPluginTestHarness(bkash, { settings: { ...settings, ...overrides }, fetch: bank.fetch, features: ["bkash"] });
  /** Runs one provider operation and checks that nothing it returned, raised or logged carries a secret or the buyer's wallet. */
  const run = async (operation: string, input: unknown) => {
    const result = await harness.provider("bkash", operation, input);
    const visible = JSON.stringify({ value: result.value, error: result.error, logs: result.logs });
    for (const secret of SECRETS) expect(visible).not.toContain(secret);
    return result;
  };
  return { bank, harness, run };
}

const sessionInput = (overrides: Json = {}) => ({
  attemptKey: "payment_session:scalius.bangladesh:bkash:4b1d0c",
  correlationId: "ORD1_full_ABCD1234",
  orderId: "ORD1",
  paymentType: "full",
  amountMinor: 12_550,
  currency: "BDT",
  wireAmount: { minor: 12_550, decimal: "125.50" },
  buyer: { name: "Rahim", phone: "+880 1712-345678" },
  urls: {
    success: "https://api.shop.test/api/v1/payment/scalius.bangladesh:bkash/success?order_id=ORD1",
    fail: "https://api.shop.test/api/v1/payment/scalius.bangladesh:bkash/fail?order_id=ORD1",
    cancel: "https://api.shop.test/api/v1/payment/scalius.bangladesh:bkash/cancel?order_id=ORD1",
    webhook: "https://api.shop.test/api/v1/webhooks/scalius.bangladesh:bkash",
  },
  requestTimeoutMs: 15_000,
  ...overrides,
});

const buyerReturn = (paymentID: string, status: string) => ({
  method: "GET",
  rawBody: "",
  headers: {},
  query: { order_id: "ORD1", paymentID, status, signature: "unchecked", apiVersion: "1.2.0-beta" },
});

const refundInput = (overrides: Json = {}) => ({
  providerRef: "",
  secondaryRef: null,
  amountMinor: 12_550,
  currency: "BDT",
  wireAmount: { minor: 12_550, decimal: "125.50" },
  reason: "Customer returned the item",
  idempotencyKey: "refund:ORD1:allocation-1",
  reference: "RF-ORD1-1",
  metadata: {},
  ...overrides,
});

/** A setup with one payment the buyer authorised on bKash's page. */
async function createdPayment(overrides: Json = {}) {
  const context = setup();
  const session = (await context.run("createSession", sessionInput(overrides))).value as { providerRef: string; redirectUrl: string };
  context.bank.authorize(session.providerRef);
  return { ...context, paymentID: session.providerRef };
}

/** A setup with one completed (executed) payment. */
async function paidPayment() {
  const context = await createdPayment();
  const verified = (await context.run("verifyReturn", buyerReturn(context.paymentID, "success"))).value as { event: { secondaryRef: string } };
  return { ...context, trxID: verified.event.secondaryRef };
}

describe("bKash: sessions", () => {
  it("creates one bKash payment per attempt, with a cached token, and replays it without calling bKash", async () => {
    const { bank, harness, run } = setup();
    const created = await run("createSession", sessionInput());
    expect(created).toMatchObject({ ok: true, value: { providerRef: "TR00111A", redirectUrl: "https://sandbox.payment.bkash.com/?paymentId=TR00111A" } });

    const [grant, create] = bank.calls;
    expect(grant).toMatchObject({
      path: "token/grant",
      headers: { "Content-Type": "application/json", Accept: "application/json", username: USERNAME, password: PASSWORD },
      body: { app_key: APP_KEY, app_secret: APP_SECRET },
    });
    expect(create).toMatchObject({
      path: "create",
      headers: { Authorization: ID_TOKEN, "X-APP-Key": APP_KEY, "Content-Type": "application/json" },
      body: {
        mode: "0011",
        payerReference: "01712345678",
        callbackURL: sessionInput().urls.success,
        amount: "125.50",
        currency: "BDT",
        intent: "sale",
        merchantInvoiceNumber: "ORD1_full_ABCD1234",
      },
    });
    expect(create!.timeoutMs).toBeLessThanOrEqual(15_000);

    // The token is cached under a key that names no credential, for a little less than bKash's hour.
    const tokenKeys = [...harness.kv.keys()];
    expect(tokenKeys).toEqual([expect.stringMatching(/^bkash:token:sandbox:[0-9a-f]{32}$/)]);
    expect(harness.kv.get(tokenKeys[0]!)).toBe(ID_TOKEN);
    expect(harness.records.get("bkash-payments")?.get("TR00111A")).toMatchObject({ orderId: "ORD1", correlationId: "ORD1_full_ABCD1234", amountMinor: 12_550, closedAs: null });

    // A retry of the same attempt: the same session, nothing sent.
    expect((await run("createSession", sessionInput())).value).toEqual(created.value);
    expect(bank.calls).toHaveLength(2);

    // Another attempt reuses the cached token and gets its own payment.
    expect((await run("createSession", sessionInput({ attemptKey: "payment_session:scalius.bangladesh:bkash:second" }))).value)
      .toMatchObject({ providerRef: "TR00112A" });
    expect(bank.paths()).toEqual(["token/grant", "create", "create"]);
  });

  it("grants a new token once when bKash refuses the cached one", async () => {
    const { bank, harness, run } = setup();
    await run("createSession", sessionInput());
    bank.script("create", { status: 401, body: { message: "The incoming token has expired" } });
    expect(await run("createSession", sessionInput({ attemptKey: "attempt-2" }))).toMatchObject({ ok: true, value: { providerRef: "TR00112A" } });
    expect(bank.paths()).toEqual(["token/grant", "create", "create", "token/grant", "create"]);
    expect(harness.kv.size).toBe(1);
  });

  it("reports what bKash refused, and fails closed on credentials and settings", async () => {
    const declined = setup();
    declined.bank.script("create", fail("2006", "Invalid Amount"));
    expect((await declined.run("createSession", sessionInput())).error)
      .toMatchObject({ category: "declined", uncertain: false, code: "bkash.2006", message: "bKash did not start the payment (bKash code 2006: Invalid Amount)." });
    // Nothing was stored, so a retry creates the payment.
    expect(declined.harness.records.get("bkash-payments")?.size).toBe(0);

    const badCredentials = setup();
    badCredentials.bank.script("token/grant", fail("2079", "Invalid username and password"));
    expect((await badCredentials.run("createSession", sessionInput())).error)
      .toMatchObject({ category: "misconfigured", code: "bkash.credentials", message: "bKash rejected the app key, app secret, username or password." });
    expect(badCredentials.bank.paths()).toEqual(["token/grant"]);

    const unauthorized = setup();
    unauthorized.bank.script("token/grant", { status: 403, body: { message: "Forbidden" } });
    expect((await unauthorized.run("createSession", sessionInput())).error).toMatchObject({ category: "misconfigured", code: "bkash.credentials" });

    const unset = setup({ bkash_password: "" });
    expect((await unset.run("createSession", sessionInput())).error).toMatchObject({ category: "misconfigured", code: "bkash.settings" });
    expect(unset.bank.calls).toHaveLength(0);
  });

  it("raises an uncertain retryable error when bKash's answer to a create is lost", async () => {
    const { bank, harness, run } = setup();
    bank.script("create", timeout());
    expect((await run("createSession", sessionInput())).error).toMatchObject({ category: "retryable", uncertain: true, code: "bkash.timeout" });
    bank.script("create", { status: 502, body: "<html>Bad gateway</html>" });
    expect((await run("createSession", sessionInput())).error).toMatchObject({ category: "retryable", uncertain: true, code: "bkash.unavailable" });
    expect(harness.records.get("bkash-payments")?.size).toBe(0);
  });
});

describe("bKash: buyer returns", () => {
  it("executes a success return and confirms the exact amount, without the buyer's wallet", async () => {
    const { bank, run, paymentID } = await createdPayment();
    const verified = await run("verifyReturn", buyerReturn(paymentID, "success"));
    expect(verified.value).toEqual({
      status: "event",
      event: {
        kind: "confirmed",
        eventType: "bkash.payment",
        eventId: "TRX2B",
        orderId: "ORD1",
        providerRef: paymentID,
        secondaryRef: "TRX2B",
        amountMinor: 12_550,
        currency: "BDT",
        paymentType: "full",
        details: { environment: "sandbox" },
      },
    });
    expect(bank.calls.at(-1)).toMatchObject({ path: "execute", headers: { Authorization: ID_TOKEN, "X-APP-Key": APP_KEY }, body: { paymentID } });
  });

  it("gives a repeated success return the same event through Query, and a lost Execute answer a retry", async () => {
    const { bank, run, paymentID } = await createdPayment();
    // bKash completes the payment, but its answer to Execute is lost.
    bank.script("execute", "lost");
    expect((await run("verifyReturn", buyerReturn(paymentID, "success"))).value)
      .toEqual({ status: "retry", reason: "bKash did not answer in time." });

    // The buyer's browser returns again: Execute answers 2062 (already completed) and Query confirms it.
    const first = await run("verifyReturn", buyerReturn(paymentID, "success"));
    const second = await run("verifyReturn", buyerReturn(paymentID, "success"));
    expect(first.value).toMatchObject({ status: "event", event: { kind: "confirmed", eventId: "TRX2B", amountMinor: 12_550 } });
    expect(second.value).toEqual(first.value);
    expect(bank.paths().slice(-5)).toEqual(["execute", "execute", "payment/status", "execute", "payment/status"]);
  });

  it("releases a cancelled or failed return with the authenticated correlation id, and never executes it later", async () => {
    const { bank, harness, run, paymentID } = await createdPayment();
    const cancelled = await run("verifyReturn", buyerReturn(paymentID, "cancel"));
    expect(cancelled.value).toEqual({
      status: "event",
      event: {
        kind: "cancelled",
        eventType: "bkash.payment",
        eventId: `${paymentID}:cancelled`,
        orderId: "ORD1",
        providerRef: paymentID,
        correlationId: "ORD1_full_ABCD1234",
        details: { environment: "sandbox", transactionStatus: "Initiated" },
      },
    });
    expect(bank.calls.at(-1)).toMatchObject({ path: "payment/status", body: { paymentID } });
    expect(harness.records.get("bkash-payments")?.get(paymentID)).toMatchObject({ closedAs: "cancelled" });

    // A success return for the released payment is not executed: the same cancellation again.
    expect((await run("verifyReturn", buyerReturn(paymentID, "success"))).value).toEqual(cancelled.value);
    expect(bank.paths()).not.toContain("execute");

    const failed = await createdPayment({ attemptKey: "attempt-failure", correlationId: "ORD1_full_FAIL0001" });
    expect((await failed.run("verifyReturn", buyerReturn(failed.paymentID, "failure"))).value).toMatchObject({
      status: "event",
      event: { kind: "failed", eventId: `${failed.paymentID}:failed`, correlationId: "ORD1_full_FAIL0001" },
    });
  });

  it("fails a success return bKash refuses to execute, and confirms a cancel return bKash reports completed", async () => {
    const unpaid = setup();
    const session = (await unpaid.run("createSession", sessionInput())).value as { providerRef: string };
    // The buyer never authorised it, so Execute is refused (2056) and the status is still Initiated.
    expect((await unpaid.run("verifyReturn", buyerReturn(session.providerRef, "success"))).value)
      .toMatchObject({ status: "event", event: { kind: "failed", correlationId: "ORD1_full_ABCD1234" } });

    const { run, paymentID } = await paidPayment();
    expect((await run("verifyReturn", buyerReturn(paymentID, "cancel"))).value)
      .toMatchObject({ status: "event", event: { kind: "confirmed", eventId: "TRX2B" } });
  });

  it("refuses forged and malformed returns without calling bKash", async () => {
    const { bank, run } = await createdPayment();
    const before = bank.calls.length;
    expect((await run("verifyReturn", buyerReturn("TR0011FORGED", "success"))).value)
      .toEqual({ status: "invalid", reason: "The return names a bKash payment this store did not create." });
    expect((await run("verifyReturn", buyerReturn("TR00111A", "paid"))).value).toMatchObject({ status: "invalid" });
    expect((await run("verifyReturn", buyerReturn("../TR00111A", "success"))).value).toMatchObject({ status: "invalid" });
    expect(bank.calls).toHaveLength(before);
  });

  it("asks for a retry while bKash is unreachable or busy", async () => {
    const { bank, run, paymentID } = await createdPayment();
    bank.script("payment/status", new Error("[http.failed] The request to tokenized.sandbox.bka.sh failed."));
    expect((await run("verifyReturn", buyerReturn(paymentID, "cancel"))).value)
      .toEqual({ status: "retry", reason: "bKash could not be reached." });
    bank.script("execute", fail("9999", "System Error"));
    bank.script("payment/status", { body: { statusCode: "0000", paymentID, transactionStatus: "Initiated", amount: "125.50", currency: "BDT" } });
    expect((await run("verifyReturn", buyerReturn(paymentID, "success"))).value)
      .toEqual({ status: "retry", reason: "bKash has not completed this payment yet." });
  });

  it("refuses a completed payment whose amount or currency differs from the one created", async () => {
    const { bank, harness, run, paymentID } = await createdPayment();
    bank.script("execute", { body: { statusCode: "0000", paymentID, trxID: "TRX9", transactionStatus: "Completed", amount: "100.00", currency: "BDT", merchantInvoiceNumber: "ORD1_full_ABCD1234" } });
    expect((await run("verifyReturn", buyerReturn(paymentID, "success"))).value)
      .toEqual({ status: "invalid", reason: "bKash reports another amount than this payment's." });
    bank.script("payment/status", { body: { statusCode: "0000", paymentID, trxID: "TRX9", transactionStatus: "Completed", amount: "125.50", currency: "USD" } });
    expect((await run("queryPayment", { providerRef: paymentID, orderId: "ORD1", requestTimeoutMs: 5_000 })).error)
      .toMatchObject({ category: "declined", code: "bkash.mismatch" });
    expect(harness.logs).toContainEqual({ level: "error", message: "bKash reports another amount than this payment's.", fields: { paymentId: paymentID } });
  });

  it("ignores webhooks: bKash payments complete only through this app's Execute", async () => {
    const { bank, run } = setup();
    expect((await run("verifyWebhook", { method: "POST", rawBody: "{}", headers: {}, query: {} })).value)
      .toEqual({ status: "ignored", reason: "bKash payments are confirmed on the buyer's return and by status queries." });
    expect(bank.calls).toHaveLength(0);
  });
});

describe("bKash: status queries", () => {
  it("reports Initiated without an event, and Completed with the same event as the return", async () => {
    const { run, paymentID } = await createdPayment();
    const query = { providerRef: paymentID, orderId: "ORD1", requestTimeoutMs: 5_000 };
    expect((await run("queryPayment", query)).value).toEqual({ providerStatus: "Initiated" });

    const returned = (await run("verifyReturn", buyerReturn(paymentID, "success"))).value as { event: unknown };
    expect((await run("queryPayment", query)).value).toEqual({ providerStatus: "Completed", event: returned.event });
    expect((await run("queryPayment", { ...query, orderId: "ORD2" })).error).toMatchObject({ category: "declined", code: "bkash.unknown_payment" });
  });
});

describe("bKash: refunds", () => {
  it("refunds in full and in part, once per idempotency key", async () => {
    const { bank, harness, run, paymentID, trxID } = await paidPayment();
    const full = await run("refund", refundInput({ providerRef: paymentID, secondaryRef: trxID }));
    expect(full).toMatchObject({ ok: true, value: { refundId: "RTX3C" } });
    expect(bank.calls.at(-1)).toMatchObject({
      path: "payment/refund",
      headers: { Authorization: ID_TOKEN, "X-APP-Key": APP_KEY },
      body: { paymentID, amount: "125.50", trxID, sku: "RF-ORD1-1", reason: "Customer returned the item" },
    });

    // A replay of the same key answers from the record: bKash is not called again.
    const sent = bank.calls.length;
    expect((await run("refund", refundInput({ providerRef: paymentID, secondaryRef: trxID }))).value).toEqual({ refundId: "RTX3C" });
    expect(bank.calls).toHaveLength(sent);

    // A partial refund with no trxID on record: bKash's status names the captured transaction.
    const partial = await run("refund", refundInput({
      providerRef: paymentID,
      amountMinor: 5_000,
      wireAmount: { minor: 5_000, decimal: "50.00" },
      idempotencyKey: "refund:ORD1:allocation-2",
      reference: "RF-ORD1-2",
      reason: "",
    }));
    expect(partial.value).toEqual({ refundId: "RTX4C" });
    expect(bank.paths().slice(-2)).toEqual(["payment/status", "payment/refund"]);
    expect(bank.calls.at(-1)!.body).toMatchObject({ amount: "50.00", trxID, reason: "Refund" });
    expect([...harness.records.get("bkash-refunds")!.values()]).toEqual([
      { paymentId: paymentID, trxId: trxID, amountMinor: 12_550, state: "completed", refundTrxId: "RTX3C" },
      { paymentId: paymentID, trxId: trxID, amountMinor: 5_000, state: "completed", refundTrxId: "RTX4C" },
    ]);
  });

  it("raises an uncertain retryable error when the refund answer is lost, and refundStatus settles it", async () => {
    const { bank, run, paymentID, trxID } = await paidPayment();
    const input = refundInput({ providerRef: paymentID, secondaryRef: trxID });
    // bKash makes the refund, but its answer is lost on the way back.
    bank.script("payment/refund", "lost");
    expect((await run("refund", input)).error).toMatchObject({ category: "retryable", uncertain: true, code: "bkash.timeout" });

    // bKash's refund status settles it, and the same refund asked for again is never sent twice.
    const probe ={ providerRefundId: null, sourceRef: trxID, amountMinor: 12_550, currency: "BDT", reference: "RF-ORD1-1", idempotencyKey: input.idempotencyKey };
    expect((await run("refundStatus", probe)).value).toEqual({ outcome: "accepted", providerRefundId: "RTX3C", providerStatus: "Completed" });
    expect(bank.calls.at(-1)).toMatchObject({ path: "payment/refund", body: { paymentID, trxID } });
    expect(bank.calls.at(-1)!.body).not.toHaveProperty("amount");
    expect((await run("refund", input)).value).toEqual({ refundId: "RTX3C" });
    expect(bank.calls.filter((call) => call.path === "payment/refund" && "amount" in call.body)).toHaveLength(1);
  });

  it("answers unknown when it cannot tell, and leaves no record for a refund bKash refused", async () => {
    const { bank, harness, run, paymentID, trxID } = await paidPayment();
    const probe = (idempotencyKey: string) => ({ providerRefundId: null, sourceRef: trxID, amountMinor: 12_550, currency: "BDT", reference: "RF-ORD1-1", idempotencyKey });
    expect((await run("refundStatus", probe("never-sent"))).value)
      .toEqual({ outcome: "unknown", manualReview: true, error: "This app has no record of sending this refund to bKash." });

    // The request timed out before bKash acted, and bKash's only refund on the payment is for another amount.
    bank.script("payment/refund", timeout());
    bank.refunds.set(paymentID, { originalTrxID: trxID, refundTrxID: "RTX88", transactionStatus: "Completed", amount: "20.00", currency: "BDT" });
    const lost = refundInput({ providerRef: paymentID, secondaryRef: trxID, idempotencyKey: "lost" });
    expect((await run("refund", lost)).error).toMatchObject({ category: "retryable", uncertain: true });
    const unmatched = (await run("refundStatus", probe("lost"))).value;
    expect(unmatched).toMatchObject({ outcome: "unknown", manualReview: true });
    expect(unmatched).not.toHaveProperty("providerRefundId");
    // Asked again, the refund is still not sent a second time.
    expect((await run("refund", lost)).error).toMatchObject({ category: "retryable", uncertain: true, code: "bkash.refund_pending" });

    // bKash unreachable: unknown, asked again later.
    bank.script("payment/refund", new Error("[http.failed] The request failed."));
    expect((await run("refundStatus", probe("lost"))).value).toEqual({ outcome: "unknown", error: "bKash could not be reached." });
    expect(bank.calls.filter((call) => call.path === "payment/refund" && "amount" in call.body)).toHaveLength(1);

    // A business refusal is final and nothing is recorded, so the key may be sent again.
    bank.script("payment/refund", fail("2023", "Insufficient Balance"));
    expect((await run("refund", refundInput({ providerRef: paymentID, secondaryRef: trxID, idempotencyKey: "refused" }))).error)
      .toMatchObject({ category: "declined", code: "bkash.2023", message: "bKash refused the refund (bKash code 2023: Insufficient Balance)." });
    expect(harness.records.get("bkash-refunds")?.size).toBe(1);
  });
});

describe("bKash: connection", () => {
  it("tests the saved credentials without echoing them", async () => {
    const working = setup();
    expect((await working.run("testConnection", {})).value).toEqual({ ok: true, message: "Connected to bKash sandbox." });

    const refused = setup({ bkash_environment: "live" });
    refused.bank.script("token/grant", { status: 401, body: { message: "Unauthorized" } });
    expect((await refused.run("testConnection", {})).value)
      .toEqual({ ok: false, message: "bKash rejected the app key, app secret, username or password." });
    expect(refused.bank.calls).toMatchObject([{ environment: "live", path: "token/grant" }]);

    const down = setup();
    down.bank.script("token/grant", { status: 503, body: "Service Unavailable" });
    expect((await down.run("testConnection", {})).value).toEqual({ ok: false, message: "bKash is unavailable (HTTP 503)." });
    expect(down.harness.kv.size).toBe(0);
  });
});
