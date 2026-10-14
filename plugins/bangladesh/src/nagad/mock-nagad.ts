// Test support (not part of the plugin bundle): a stand-in for Nagad's
// Online Payment API behind the test harness's `fetch`. It holds Nagad's
// private key and the merchant's public key, so it really decrypts and
// signature-checks every request and seals its answers the way Nagad's
// documentation describes; the plugin's crypto is proven end to end.

import {
  bytesToBase64,
  base64ToBytes,
  decryptPkcs1v15,
  encryptPkcs1v15,
  importRsaPrivateKey,
  importRsaPublicKey,
  signSha256,
  verifySha256,
  type RsaPrivateKey,
  type RsaPublicKey,
} from "./rsa";

export const SANDBOX_BASE = "https://sandbox-ssl.mynagad.com:10061/remote-payment-gateway-1.0/api/dfs";
export const LIVE_BASE = "https://api.mynagad.com/api/dfs";
export const MERCHANT_ID = "683002007104225";
export const MERCHANT_NUMBER = "01800000000";
/** Buyer data Verify returns: must never reach an event, an error or a log. */
export const BUYER_MOBILE = "01711111111";

export interface KeyPair {
  privatePem: string;
  publicPem: string;
}

function pem(der: ArrayBuffer, label: string): string {
  const lines = bytesToBase64(new Uint8Array(der)).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export async function generateKeyPair(modulusLength = 2048): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privatePem: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY"),
    publicPem: pem(await crypto.subtle.exportKey("spki", pair.publicKey), "PUBLIC KEY"),
  };
}

type Step = "initialize" | "complete" | "verify";
export type Fault =
  | "timeout"
  | "unreachable"
  | "server_error"
  | "bad_signature"
  | "wrong_challenge"
  | "reject_signature"
  | "decline";

export interface NagadCall {
  step: Step;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  /** The decrypted, signature-checked `sensitiveData`. */
  sensitive: Record<string, unknown> | null;
}

interface MockPayment {
  orderId: string;
  /** The challenge Nagad's initialize answer carried: complete must sign it back. */
  challenge: string;
  amount: string | null;
  status: string;
  statusCode: string;
  issuerPaymentRefNo: string | null;
}

interface HarnessResponse {
  status: number;
  body: string;
}

const json = (status: number, body: unknown): HarnessResponse => ({ status, body: JSON.stringify(body) });

export class MockNagad {
  readonly calls: NagadCall[] = [];
  readonly payments = new Map<string, MockPayment>();
  /** One-shot faults by step; each is consumed by the next call of that step. */
  readonly faults: Partial<Record<Step, Fault>> = {};
  /** Fields that replace Verify's answer (a wrong amount, another order). */
  verifyOverrides: Record<string, unknown> = {};
  private counter = 0;

  private constructor(
    private readonly nagadKey: RsaPrivateKey,
    private readonly merchantKey: RsaPublicKey,
  ) {}

  static async create(nagad: KeyPair, merchant: KeyPair): Promise<MockNagad> {
    return new MockNagad(await importRsaPrivateKey(nagad.privatePem), await importRsaPublicKey(merchant.publicPem));
  }

  /** What Nagad's Verify reports for a reference from now on. */
  settle(reference: string, status: string, issuerPaymentRefNo: string | null = null): void {
    const payment = this.payments.get(reference);
    if (!payment) throw new Error(`No mock payment ${reference}.`);
    payment.status = status;
    payment.statusCode = status === "Success" ? "000" : "001";
    payment.issuerPaymentRefNo = issuerPaymentRefNo;
  }

  callsOf(step: Step): NagadCall[] {
    return this.calls.filter((call) => call.step === step);
  }

  /** The harness's `fetch` option. */
  readonly fetch = async (url: string, init: unknown): Promise<HarnessResponse> => {
    const request = init as { method?: string; headers?: Record<string, string>; body?: string };
    const base = url.startsWith(SANDBOX_BASE) ? SANDBOX_BASE : LIVE_BASE;
    const path = url.slice(base.length);
    const step: Step = path.startsWith("/check-out/initialize/") ? "initialize" : path.startsWith("/check-out/complete/") ? "complete" : "verify";
    const call: NagadCall = {
      step,
      url,
      method: request.method ?? "GET",
      headers: request.headers ?? {},
      body: request.body ? JSON.parse(request.body) as Record<string, unknown> : null,
      sensitive: null,
    };
    this.calls.push(call);
    const fault = this.faults[step];
    delete this.faults[step];
    // The harness bridge reports transport failures the way the platform does: `[code] message`.
    if (fault === "timeout") throw new Error("[http.timeout] The request timed out.");
    if (fault === "unreachable") throw new Error("[http.failed] The request to sandbox-ssl.mynagad.com failed.");
    if (fault === "server_error") return { status: 502, body: "<html>Bad gateway</html>" };
    if (fault === "reject_signature") return json(400, { reason: "INVALID_SIGNATURE", message: "Invalid Signature" });
    if (step === "initialize") return this.initialize(call, path, fault);
    if (step === "complete") return this.complete(call, path, fault);
    return this.verify(path);
  };

  private async open(call: NagadCall): Promise<Record<string, unknown> | null> {
    const sensitiveData = call.body?.sensitiveData;
    const signature = call.body?.signature;
    if (typeof sensitiveData !== "string" || typeof signature !== "string") return null;
    const plaintext = decryptPkcs1v15(this.nagadKey, base64ToBytes(sensitiveData));
    if (!(await verifySha256(this.merchantKey, base64ToBytes(signature), plaintext))) return null;
    call.sensitive = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    return call.sensitive;
  }

  private async seal(reply: Record<string, unknown>, forgeSignature: boolean): Promise<Record<string, string>> {
    const plaintext = new TextEncoder().encode(JSON.stringify(reply));
    const signed = forgeSignature ? new TextEncoder().encode(JSON.stringify({ ...reply, paymentReferenceId: "forged" })) : plaintext;
    return {
      sensitiveData: bytesToBase64(encryptPkcs1v15(this.merchantKey, plaintext)),
      signature: bytesToBase64(await signSha256(this.nagadKey, signed)),
    };
  }

  private async initialize(call: NagadCall, path: string, fault: Fault | undefined): Promise<HarnessResponse> {
    const route = /^\/check-out\/initialize\/([^/]+)\/([^/?]+)\?locale=EN$/.exec(path);
    const sensitive = await this.open(call);
    if (!route || !sensitive) return json(400, { reason: "INVALID_SIGNATURE", message: "Invalid Signature" });
    const valid = sensitive.merchantId === route[1]
      && sensitive.orderId === route[2]
      && sensitive.datetime === call.body?.dateTime
      && typeof sensitive.challenge === "string" && /^[0-9a-f]{40}$/.test(sensitive.challenge);
    if (!valid) return json(400, { reason: "INVALID_REQUEST", message: "Invalid request" });
    this.counter += 1;
    // Nagad's references look like base64; this one always holds '+' and '/' ("++//"), which URLs must escape.
    const reference = bytesToBase64(new Uint8Array([0xfb, 0xef, 0xff, ...new TextEncoder().encode(`${route[2]}.${this.counter}`)]));
    const challenge = fault === "wrong_challenge" ? "f".repeat(40) : sensitive.challenge as string;
    this.payments.set(reference, { orderId: route[2]!, challenge, amount: null, status: "OrderInitiated", statusCode: "001", issuerPaymentRefNo: null });
    return json(200, await this.seal({ paymentReferenceId: reference, challenge, acceptDateTime: "20261003120000" }, fault === "bad_signature"));
  }

  private async complete(call: NagadCall, path: string, fault: Fault | undefined): Promise<HarnessResponse> {
    const reference = decodeURIComponent(path.slice("/check-out/complete/".length));
    const payment = this.payments.get(reference);
    const sensitive = await this.open(call);
    if (!payment || !sensitive) return json(400, { reason: "INVALID_SIGNATURE", message: "Invalid Signature" });
    const valid = sensitive.merchantId === MERCHANT_ID
      && sensitive.orderId === payment.orderId
      && sensitive.currencyCode === "050"
      && sensitive.challenge === payment.challenge
      && typeof sensitive.amount === "string";
    if (!valid) return json(400, { reason: "INVALID_REQUEST", message: "Invalid request" });
    if (fault === "decline") {
      return json(200, { status: "Failed", reason: "TRANSACTION_LIMIT", message: `Limit exceeded for ${BUYER_MOBILE}` });
    }
    payment.amount = sensitive.amount as string;
    payment.status = "Ready";
    return json(200, { status: "Success", callBackUrl: `https://sandbox-ssl.mynagad.com:10061/check-out/pay/${encodeURIComponent(reference)}` });
  }

  private verify(path: string): HarnessResponse {
    const reference = decodeURIComponent(path.slice("/verify/payment/".length));
    const payment = this.payments.get(reference);
    if (!payment) return json(200, { reason: "PAYMENT_NOT_FOUND", message: "Payment not found" });
    return json(200, {
      merchantId: MERCHANT_ID,
      orderId: payment.orderId,
      paymentRefId: reference,
      amount: payment.amount,
      clientMobileNo: BUYER_MOBILE,
      merchantMobileNo: MERCHANT_NUMBER,
      orderDateTime: "2026-10-03 12:00:00",
      issuerPaymentDateTime: payment.status === "Success" ? "2026-10-03 12:01:00" : null,
      issuerPaymentRefNo: payment.issuerPaymentRefNo,
      additionalMerchantInfo: null,
      status: payment.status,
      statusCode: payment.statusCode,
      cancelIssuerDateTime: null,
      cancelIssuerRefNo: null,
      ...this.verifyOverrides,
    });
  }
}
