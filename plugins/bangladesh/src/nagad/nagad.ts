// Nagad's Online Payment API (header version v-0.2.0), as documented:
// initialize a checkout, complete it to get the page the buyer pays on, and
// verify a payment server to server. UNVERIFIED: written from the public
// documentation without sandbox access (README.md lists what to confirm).
//
// Initialize and complete carry `sensitiveData` (JSON encrypted with Nagad's
// public key) and `signature` (the same JSON signed with the merchant's
// private key); Nagad's initialize answer comes back the same way in
// reverse. Verify is a plain GET.
//
// Every failure is a `ProviderError` whose message is safe for a merchant:
// never a key, a signature, `sensitiveData`, a mobile number or a raw body.

import { ProviderError, type PluginContext, type PluginHttp, type PluginHttpResponse } from "@scalius/plugin-sdk";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decryptPkcs1v15,
  encryptPkcs1v15,
  importRsaPrivateKey,
  importRsaPublicKey,
  RsaError,
  signSha256,
  verifySha256,
  type RsaPrivateKey,
  type RsaPublicKey,
} from "./rsa";

/** The sandbox listens on port 10061, so its entry names that exact port. */
export const NAGAD_HOSTS = ["api.mynagad.com", "sandbox-ssl.mynagad.com:10061"];

const BASE_URLS = {
  live: "https://api.mynagad.com/api/dfs",
  sandbox: "https://sandbox-ssl.mynagad.com:10061/remote-payment-gateway-1.0/api/dfs",
} as const;

export type NagadEnvironment = keyof typeof BASE_URLS;

/** ISO 4217 numeric code of BDT, as Nagad's `currencyCode` wants it. */
const BDT_CURRENCY_CODE = "050";
export const DEFAULT_SERVER_IP = "127.0.0.1";

/** Nagad's payment references look like base64; they travel in URL paths and query strings. */
export const NAGAD_REFERENCE = /^[A-Za-z0-9+/=._-]{1,200}$/;
const MERCHANT_ID = /^[A-Za-z0-9]{1,40}$/;
const MERCHANT_NUMBER = /^01\d{9}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

type Settings = PluginContext["settings"];
type Answer = Record<string, unknown>;

/** What every call needs: where Nagad is and the headers it expects. */
export interface NagadEndpoint {
  environment: NagadEnvironment;
  baseUrl: string;
  merchantId: string;
  headers: Record<string, string>;
}

/** What initialize and complete need besides: the merchant number and both keys. */
export interface NagadCredentials extends NagadEndpoint {
  merchantNumber: string | null;
  merchantKey: RsaPrivateKey;
  nagadKey: RsaPublicKey;
}

function misconfigured(message: string, code: string): ProviderError {
  return new ProviderError("misconfigured", message, { code });
}

function textSetting(settings: Settings, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value.trim() : "";
}

// ── Settings ────────────────────────────────────────────────────────────────

export function nagadEndpoint(settings: Settings): NagadEndpoint {
  const environment = textSetting(settings, "environment") || "sandbox";
  if (environment !== "sandbox" && environment !== "live") {
    throw misconfigured("Choose the Nagad environment: sandbox or live.", "nagad.environment");
  }
  const merchantId = textSetting(settings, "merchant_id");
  if (!MERCHANT_ID.test(merchantId)) {
    throw misconfigured("Enter your Nagad merchant ID (letters and digits) in the Nagad settings.", "nagad.merchant_id");
  }
  const serverIp = textSetting(settings, "server_ip") || DEFAULT_SERVER_IP;
  if (!IPV4.test(serverIp)) {
    throw misconfigured("The server IP in the Nagad settings must be an IPv4 address, such as 203.0.113.10.", "nagad.server_ip");
  }
  return {
    environment,
    baseUrl: BASE_URLS[environment],
    merchantId,
    headers: {
      "Content-Type": "application/json",
      "X-KM-Api-Version": "v-0.2.0",
      "X-KM-IP-V4": serverIp,
      "X-KM-Client-Type": "PC_WEB",
    },
  };
}

const KEY_PROBLEMS = {
  merchant: {
    missing: "Paste your merchant private key in the Nagad settings.",
    unreadable: "The merchant private key is not a readable RSA private key. Paste the PKCS#8 key (-----BEGIN PRIVATE KEY-----).",
    pkcs1: "The merchant private key is a PKCS#1 key. Convert it with: openssl pkcs8 -topk8 -nocrypt -in merchant.pem",
    too_small: "The merchant private key must be at least 2048 bits.",
  },
  nagad: {
    missing: "Paste the public key Nagad gave you in the Nagad settings.",
    unreadable: "The Nagad public key is not a readable RSA public key (-----BEGIN PUBLIC KEY-----).",
    pkcs1: "The Nagad public key is a PKCS#1 key. Convert it with: openssl rsa -RSAPublicKey_in -in nagad.pem -pubout",
    too_small: "The Nagad public key must be at least 2048 bits.",
  },
} as const;

async function importKey<T>(owner: keyof typeof KEY_PROBLEMS, text: string, load: (text: string) => Promise<T>): Promise<T> {
  const problems = KEY_PROBLEMS[owner];
  const code = `nagad.${owner}_key`;
  if (text === "") throw misconfigured(problems.missing, code);
  try {
    return await load(text);
  } catch (error) {
    const reason = error instanceof RsaError && (error.reason === "pkcs1" || error.reason === "too_small") ? error.reason : "unreadable";
    throw misconfigured(problems[reason], code);
  }
}

/** Reads and checks every setting initialize and complete need. Nothing here calls Nagad. */
export async function nagadCredentials(settings: Settings): Promise<NagadCredentials> {
  const endpoint = nagadEndpoint(settings);
  // Accepted with or without the +88 country prefix; Nagad's accountNumber is the local form.
  const merchantNumber = textSetting(settings, "merchant_number").replace(/^\+?88/, "") || null;
  if (merchantNumber !== null && !MERCHANT_NUMBER.test(merchantNumber)) {
    throw misconfigured("The merchant number must be the 11-digit Nagad wallet number (01XXXXXXXXX), or empty.", "nagad.merchant_number");
  }
  const merchantKey = await importKey("merchant", textSetting(settings, "merchant_private_key"), importRsaPrivateKey);
  const nagadKey = await importKey("nagad", textSetting(settings, "nagad_public_key"), importRsaPublicKey);
  // The most likely key mix-up: the merchant's own public key pasted where Nagad's belongs.
  if (nagadKey.modulus === merchantKey.modulus) {
    throw misconfigured("The Nagad public key field holds your own public key. Paste the public key Nagad gave you.", "nagad.nagad_key");
  }
  return { ...endpoint, merchantNumber, merchantKey, nagadKey };
}

// ── Values ──────────────────────────────────────────────────────────────────

/** `yyyyMMddHHmmss` in Asia/Dhaka (UTC+6 all year: Bangladesh has no daylight saving time). */
export function dhakaDateTime(now: Date): string {
  const dhaka = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${dhaka.getUTCFullYear()}${two(dhaka.getUTCMonth() + 1)}${two(dhaka.getUTCDate())}`
    + `${two(dhaka.getUTCHours())}${two(dhaka.getUTCMinutes())}${two(dhaka.getUTCSeconds())}`;
}

/** 40 random hex characters. */
function randomChallenge(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(20)));
}

/**
 * A BDT amount ("125.50", "125.5", "125") in integer paisa, by string
 * arithmetic: a float never touches money. Null for anything else, including
 * more precision than a paisa.
 */
export function parseAmountMinor(amount: string): number | null {
  const match = /^(\d{1,13})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  if (/[^0]/.test(fraction.slice(2))) return null;
  const minor = Number(`${match[1]}${fraction.slice(0, 2)}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Nagad's statuses, as the platform needs them. Unknown statuses are not final. */
export type NagadOutcome = "paid" | "cancelled" | "failed" | "pending";

const CANCELLED_STATUSES = new Set(["aborted", "cancelled", "canceled"]);
const FAILED_STATUSES = new Set(["failed", "fraud", "invalidrequest", "unknownfailed", "expired"]);

export function nagadOutcome(status: string): NagadOutcome {
  const key = status.toLowerCase().replace(/[\s_-]/g, "");
  if (key === "success") return "paid";
  if (CANCELLED_STATUSES.has(key)) return "cancelled";
  if (FAILED_STATUSES.has(key)) return "failed";
  return "pending";
}

function textField(answer: Answer, key: string): string | null {
  const value = answer[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// ── Transport ───────────────────────────────────────────────────────────────

type Step = "initialize" | "complete" | "verify";

/** The platform's refusal code (`http.timeout`, `http.not_allowed`, …), when the error carries one. */
function platformCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function transportFailure(error: unknown, mayHaveActed: boolean): ProviderError {
  const code = platformCode(error);
  if (code === "http.not_allowed" || code === "http.invalid_request") {
    return misconfigured("Scalius refused to send the request to Nagad's address. Check the Nagad environment setting.", "nagad.not_allowed");
  }
  // The platform's own limit: the request never left.
  if (code === "rate_limited") {
    return new ProviderError("retryable", "Too many requests to Nagad right now. Try again in a minute.", { code: "nagad.rate_limited" });
  }
  const timedOut = code === "http.timeout";
  return new ProviderError("retryable", timedOut ? "Nagad did not answer in time." : "Nagad could not be reached.", {
    uncertain: mayHaveActed,
    code: timedOut ? "nagad.timeout" : "nagad.unreachable",
  });
}

// Words in Nagad's refusals that point at the merchant's setup rather than at this payment.
const MERCHANT_SIDE = /signature|decrypt|sensitive ?data|invalid merchant|merchant (?:not found|is not active|inactive)|unauthori[sz]ed/i;

/**
 * Nagad answered but refused. Its `reason` becomes the error code when it is
 * a short token (never a free-text message, which could quote buyer data).
 */
function refusal(status: number, answer: Answer | null): ProviderError {
  const reason = answer ? textField(answer, "reason") : null;
  const token = reason && /^(?:[A-Za-z][A-Za-z0-9_]{0,39}|\d{1,6})$/.test(reason) ? reason.toLowerCase() : `http_${status}`;
  const said = answer ? `${reason ?? ""} ${textField(answer, "message") ?? ""}` : "";
  if (status === 401 || status === 403 || MERCHANT_SIDE.test(said)) {
    return misconfigured("Nagad rejected the merchant credentials or signature. Check the merchant ID, keys and server IP in the Nagad settings.", `nagad.${token}`);
  }
  return new ProviderError("declined", "Nagad declined the payment request.", { code: `nagad.${token}` });
}

async function jsonObject(response: PluginHttpResponse): Promise<Answer | null> {
  try {
    const value: unknown = JSON.parse(await response.text());
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Answer : null;
  } catch {
    return null;
  }
}

function unreadable(mayHaveActed: boolean): ProviderError {
  return new ProviderError("retryable", "Nagad's answer could not be read.", { uncertain: mayHaveActed, code: "nagad.unreadable_answer" });
}

async function callNagad(
  http: PluginHttp,
  endpoint: NagadEndpoint,
  step: Step,
  path: string,
  timeoutMs: number,
  body?: Answer,
): Promise<Answer> {
  // Initialize and complete change state at Nagad: an answer lost after the request left is uncertain.
  const mayHaveActed = step !== "verify";
  let response: PluginHttpResponse;
  try {
    response = await http.fetch(`${endpoint.baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: endpoint.headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      timeoutMs,
    });
  } catch (error) {
    throw transportFailure(error, mayHaveActed);
  }
  if (response.status >= 500) {
    throw new ProviderError("retryable", "Nagad answered with a server error.", { uncertain: mayHaveActed, code: "nagad.server_error" });
  }
  if (response.status === 429) {
    throw new ProviderError("retryable", "Nagad is limiting requests. Try again in a minute.", { code: "nagad.rate_limited" });
  }
  const answer = await jsonObject(response);
  if (!response.ok) throw refusal(response.status, answer);
  if (!answer) throw unreadable(mayHaveActed);
  return answer;
}

// ── The envelope ────────────────────────────────────────────────────────────

/** `sensitiveData` and `signature` of one JSON object: encrypted to Nagad, signed by the merchant. */
async function seal(credentials: NagadCredentials, payload: Record<string, string>): Promise<{ sensitiveData: string; signature: string }> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  let encrypted: Uint8Array;
  try {
    encrypted = encryptPkcs1v15(credentials.nagadKey, plaintext);
  } catch {
    throw misconfigured("The request is too long for the Nagad public key. Check the merchant ID and the key.", "nagad.nagad_key");
  }
  return { sensitiveData: bytesToBase64(encrypted), signature: bytesToBase64(await signSha256(credentials.merchantKey, plaintext)) };
}

async function signedByNagad(credentials: NagadCredentials, signature: string, plaintext: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    return await verifySha256(credentials.nagadKey, base64ToBytes(signature), plaintext);
  } catch {
    return false;
  }
}

/** Nagad's sealed answer: decrypted with the merchant key, and trusted only with Nagad's signature over the plaintext. */
async function unseal(credentials: NagadCredentials, answer: Answer): Promise<Answer> {
  const sensitiveData = textField(answer, "sensitiveData");
  const signature = textField(answer, "signature");
  if (!sensitiveData || !signature) throw refusal(200, answer);
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    plaintext = decryptPkcs1v15(credentials.merchantKey, base64ToBytes(sensitiveData));
  } catch {
    throw misconfigured(
      "Nagad's answer could not be decrypted with the merchant private key. Check that Nagad has your current public key.",
      "nagad.decrypt_failed",
    );
  }
  if (!(await signedByNagad(credentials, signature, plaintext))) {
    throw misconfigured("Nagad's answer failed its signature check. Check the Nagad public key in the Nagad settings.", "nagad.bad_signature");
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Answer;
  } catch {
    // Falls through: a signed answer that is not a JSON object.
  }
  throw unreadable(true);
}

// ── Calls ───────────────────────────────────────────────────────────────────

/**
 * Check-out initialize: registers `orderId` with Nagad and returns its
 * payment reference and the challenge to sign into complete.
 */
export async function initializePayment(
  http: PluginHttp,
  credentials: NagadCredentials,
  orderId: string,
  timeoutMs: number,
): Promise<{ paymentReferenceId: string; challenge: string }> {
  const dateTime = dhakaDateTime(new Date());
  const challenge = randomChallenge();
  const sealed = await seal(credentials, { merchantId: credentials.merchantId, datetime: dateTime, orderId, challenge });
  const path = `/check-out/initialize/${encodeURIComponent(credentials.merchantId)}/${encodeURIComponent(orderId)}?locale=EN`;
  const answer = await callNagad(http, credentials, "initialize", path, timeoutMs, {
    ...(credentials.merchantNumber ? { accountNumber: credentials.merchantNumber } : {}),
    dateTime,
    ...sealed,
  });
  const reply = await unseal(credentials, answer);
  const paymentReferenceId = textField(reply, "paymentReferenceId");
  if (!paymentReferenceId || !NAGAD_REFERENCE.test(paymentReferenceId)) throw unreadable(true);
  // The echoed challenge binds the answer to this request, so an old signed answer cannot be replayed.
  const echoed = textField(reply, "challenge");
  if (echoed !== challenge) {
    throw misconfigured("Nagad's answer did not carry this request's challenge, so it was not trusted.", "nagad.challenge_mismatch");
  }
  return { paymentReferenceId, challenge: echoed };
}

/** Check-out complete: fixes the amount and the return URL; answers with the page the buyer pays on. */
export async function completePayment(
  http: PluginHttp,
  credentials: NagadCredentials,
  input: { paymentReferenceId: string; orderId: string; amount: string; challenge: string; callbackUrl: string; timeoutMs: number },
): Promise<string> {
  const sealed = await seal(credentials, {
    merchantId: credentials.merchantId,
    orderId: input.orderId,
    currencyCode: BDT_CURRENCY_CODE,
    amount: input.amount,
    challenge: input.challenge,
  });
  const answer = await callNagad(http, credentials, "complete", `/check-out/complete/${encodeURIComponent(input.paymentReferenceId)}`, input.timeoutMs, {
    ...sealed,
    merchantCallbackURL: input.callbackUrl,
    additionalMerchantInfo: {},
  });
  const callBackUrl = textField(answer, "callBackUrl");
  if (textField(answer, "status")?.toLowerCase() !== "success" || !callBackUrl) throw refusal(200, answer);
  if (!isHttpsUrl(callBackUrl)) throw misconfigured("Nagad sent a payment page address that is not https.", "nagad.insecure_redirect");
  return callBackUrl;
}

/** The facts of a Verify Payment answer the plugin uses (never the buyer's mobile number). */
export interface NagadVerification {
  paymentRefId: string;
  orderId: string;
  merchantId: string | null;
  amount: string | null;
  status: string;
  statusCode: string | null;
  issuerPaymentRefNo: string | null;
}

/** Verify Payment: Nagad's own answer about one payment reference. A read: a lost answer is never uncertain. */
export async function verifyPayment(http: PluginHttp, endpoint: NagadEndpoint, paymentRefId: string, timeoutMs: number): Promise<NagadVerification> {
  const answer = await callNagad(http, endpoint, "verify", `/verify/payment/${encodeURIComponent(paymentRefId)}`, timeoutMs);
  const reference = textField(answer, "paymentRefId");
  const orderId = textField(answer, "orderId");
  const status = textField(answer, "status");
  if (!reference || !orderId || !status) throw refusal(200, answer);
  return {
    paymentRefId: reference,
    orderId,
    merchantId: textField(answer, "merchantId"),
    amount: textField(answer, "amount"),
    status,
    statusCode: textField(answer, "statusCode"),
    issuerPaymentRefNo: textField(answer, "issuerPaymentRefNo"),
  };
}
