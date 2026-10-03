// The bKash Tokenized Checkout API (v1.2.0-beta) over `ctx.http`: the saved
// credentials, the cached grant token, one JSON POST per call, and every way
// a call can fail mapped onto the port's `ProviderError`. Nothing here knows
// about orders or refunds; payments.ts and refunds.ts decide what an answer
// means.
//
// bKash answers most refusals with HTTP 200 and a non-"0000" `statusCode`
// (older endpoints: `errorCode`), so a reply is either an answer or a
// rejection carrying bKash's code. Transport failures throw: `retryable`, and
// `uncertain` when a mutating call (create, execute, refund) may have reached
// bKash before its answer was lost.

import { ProviderError, type PluginContext, type PluginHttpResponse } from "@scalius/plugin-sdk";
import { sha256Hex } from "./hash";

type Settings = PluginContext["settings"];

export const BKASH_HOSTS = { sandbox: "tokenized.sandbox.bka.sh", live: "tokenized.pay.bka.sh" } as const;
export type BkashEnvironment = keyof typeof BKASH_HOSTS;

type BkashPath = "token/grant" | "create" | "execute" | "payment/status" | "payment/refund";

/** bKash's paymentIDs, trxIDs and refundTrxIDs: short alphanumerics. Anything else is not one. */
export const BKASH_ID = /^[A-Za-z0-9_-]{1,128}$/;

const SUCCESS_CODE = "0000";
/** bKash's own codes for "down or busy, ask again": maintenance and system error. */
const TRANSIENT_CODES = new Set(["503", "9999"]);
/** Codes that mean the saved credentials are wrong (an invalid app key). */
const CREDENTIAL_CODES = new Set(["2001"]);
/** bKash's short messages are shown to the merchant only without digits, so never with a wallet number or a token. */
const SAFE_MESSAGE = /^[A-Za-z][A-Za-z ,.'()/-]{0,119}$/;
/** A cached token is dropped this long before bKash expires it. */
const TOKEN_MARGIN_SECONDS = 300;
/** A call is not started with less time than this left in the operation's budget. */
const MIN_CALL_MS = 500;
/** The platform's ceiling for one outbound request. */
const MAX_CALL_MS = 30_000;

export interface BkashCredentials {
  environment: BkashEnvironment;
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
}

/** One bKash JSON answer. */
export type BkashAnswer = Readonly<Record<string, unknown>>;

/** bKash refused the request: nothing was done. */
export interface BkashRejection {
  /** bKash's `statusCode` (or `errorCode`), such as "2023". */
  code: string;
  /** bKash's own short description when it is safe to show, else null. */
  message: string | null;
  /** bKash is down or busy: the same request may succeed later. */
  transient: boolean;
}

export type BkashReply = { ok: true; answer: BkashAnswer } | { ok: false; rejection: BkashRejection };

export interface BkashClient {
  readonly environment: BkashEnvironment;
  /** Grants a fresh token (and caches it): proves the saved credentials. */
  authenticate(): Promise<void>;
  /** One authorized call. Throws `ProviderError` when bKash could not be asked or its answer could not be read. */
  post(path: Exclude<BkashPath, "token/grant">, body: Record<string, string>, options: { mutating: boolean }): Promise<BkashReply>;
}

/** A field of an answer as trimmed text ("" when absent): bKash sends amounts and ids as strings, sometimes as numbers. */
export function field(answer: BkashAnswer, name: string): string {
  const value = answer[name];
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export function isCompleted(answer: BkashAnswer): boolean {
  return field(answer, "transactionStatus") === "Completed";
}

/**
 * A bKash amount ("125.50", "125.5", "125") in paisa, exactly: the digits are
 * joined as text, never multiplied as a float. Null for anything else,
 * including a third decimal that is not zero.
 */
export function takaToMinor(amount: string): number | null {
  const match = /^(\d{1,15})(?:\.(\d{1,2})0*)?$/.exec(amount);
  if (!match) return null;
  const minor = Number(`${match[1]}${(match[2] ?? "").padEnd(2, "0")}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** The stable code of a platform refusal (`http.timeout`, `storage.unique_violation`), as the SDK runtime raises it. */
export function platformErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/** A rejection as the port's error: `retryable` while bKash is busy, `misconfigured` for bad credentials, else `declined`. */
export function rejectionError(rejection: BkashRejection, action: string, options: { mutating: boolean }): ProviderError {
  const detail = rejection.message ? `${rejection.code}: ${rejection.message}` : rejection.code;
  const message = `${action} (bKash code ${detail}).`;
  const code = `bkash.${rejection.code.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32) || "rejected"}`;
  if (rejection.transient) return new ProviderError("retryable", message, { uncertain: options.mutating, code });
  if (CREDENTIAL_CODES.has(rejection.code)) return new ProviderError("misconfigured", message, { code });
  return new ProviderError("declined", message, { code });
}

/** Query Payment: bKash's current record of a payment. A refusal (an unknown paymentID) throws. */
export async function paymentStatus(client: BkashClient, paymentId: string): Promise<BkashAnswer> {
  const reply = await client.post("payment/status", { paymentID: paymentId }, { mutating: false });
  if (!reply.ok) throw rejectionError(reply.rejection, "bKash could not report the payment", { mutating: false });
  return reply.answer;
}

function settingText(settings: Settings, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value.trim() : "";
}

/** The saved settings; fails closed when any credential is missing. Anything but "live" is the sandbox. */
export function credentialsOf(settings: Settings): BkashCredentials {
  const credentials: BkashCredentials = {
    environment: settings.environment === "live" ? "live" : "sandbox",
    appKey: settingText(settings, "app_key"),
    appSecret: settingText(settings, "app_secret"),
    username: settingText(settings, "username"),
    password: settingText(settings, "password"),
  };
  if (!credentials.appKey || !credentials.appSecret || !credentials.username || !credentials.password) {
    throw new ProviderError("misconfigured", "Enter the bKash app key, app secret, username and password in the app's settings.", { code: "bkash.settings" });
  }
  return credentials;
}

function answerOf(text: string): BkashAnswer | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as BkashAnswer : null;
  } catch {
    return null;
  }
}

function rejectionOf(answer: BkashAnswer): BkashRejection | null {
  const code = field(answer, "statusCode") || field(answer, "errorCode");
  if (!code || code === SUCCESS_CODE) return null;
  const message = field(answer, "statusMessage") || field(answer, "errorMessage");
  return { code, message: SAFE_MESSAGE.test(message) ? message : null, transient: TRANSIENT_CODES.has(code) };
}

/** A request that failed before bKash answered. Only a request that may have left is uncertain. */
function unreachable(error: unknown, mutating: boolean): ProviderError {
  const code = platformErrorCode(error);
  if (code === "rate_limited") {
    return new ProviderError("retryable", "This store is sending bKash too many requests; try again in a minute.", { code: "bkash.rate_limited" });
  }
  if (code === "http.not_allowed" || code === "http.invalid_request") {
    return new ProviderError("misconfigured", "The bKash app could not send its request.", { code: "bkash.request" });
  }
  if (code === "http.timeout") {
    return new ProviderError("retryable", "bKash did not answer in time.", { uncertain: mutating, code: "bkash.timeout" });
  }
  return new ProviderError("retryable", "bKash could not be reached.", { uncertain: mutating, code: "bkash.unreachable" });
}

const credentialsRefused = () =>
  new ProviderError("misconfigured", "bKash rejected the app key, app secret, username or password.", { code: "bkash.credentials" });

/**
 * A client for one operation. `timeBudgetMs` is the whole operation's time:
 * every call (a token grant included) gets what is left of it, so together
 * they finish inside what the platform allows.
 */
export function createBkashClient(ctx: PluginContext, timeBudgetMs: number): BkashClient {
  const credentials = credentialsOf(ctx.settings);
  const base = `https://${BKASH_HOSTS[credentials.environment]}/v1.2.0-beta/tokenized/checkout`;
  const endsAt = Date.now() + timeBudgetMs;

  function timeLeft(): number {
    const left = Math.floor(endsAt - Date.now());
    if (left < MIN_CALL_MS) throw new ProviderError("retryable", "bKash did not answer in time.", { code: "bkash.timeout" });
    return Math.min(left, MAX_CALL_MS);
  }

  // Keyed by environment, app key and username (never a secret), so new credentials get a new token.
  async function tokenKey(): Promise<string> {
    const account = await sha256Hex(`${credentials.appKey}\n${credentials.username}`);
    return `token:${credentials.environment}:${account.slice(0, 32)}`;
  }

  /** One POST. "unauthorized" when bKash refused the token or credentials outright (HTTP 401/403). */
  async function send(path: BkashPath, body: Record<string, string>, headers: Record<string, string>, mutating: boolean): Promise<BkashReply | "unauthorized"> {
    let response: PluginHttpResponse;
    try {
      response = await ctx.http.fetch(`${base}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify(body),
        timeoutMs: timeLeft(),
      });
    } catch (error) {
      throw error instanceof ProviderError ? error : unreachable(error, mutating);
    }
    if (response.status === 401 || response.status === 403) return "unauthorized";
    if (response.status === 429) {
      throw new ProviderError("retryable", "bKash is limiting requests; try again shortly.", { code: "bkash.rate_limited" });
    }
    if (response.status >= 500) {
      throw new ProviderError("retryable", `bKash is unavailable (HTTP ${response.status}).`, { uncertain: mutating, code: "bkash.unavailable" });
    }
    const answer = answerOf(await response.text());
    const rejection = answer ? rejectionOf(answer) : null;
    if (rejection) return { ok: false, rejection };
    if (!answer || !response.ok) {
      throw new ProviderError("retryable", "bKash's answer could not be read.", { uncertain: mutating, code: "bkash.unreadable" });
    }
    return { ok: true, answer };
  }

  async function grant(): Promise<string> {
    const reply = await send(
      "token/grant",
      { app_key: credentials.appKey, app_secret: credentials.appSecret },
      { username: credentials.username, password: credentials.password },
      false,
    );
    if (reply === "unauthorized") throw credentialsRefused();
    if (!reply.ok) {
      // A grant fails only for its credentials, unless bKash itself is down.
      if (reply.rejection.transient) throw rejectionError(reply.rejection, "bKash could not grant a token", { mutating: false });
      throw credentialsRefused();
    }
    const token = field(reply.answer, "id_token");
    if (!token) throw new ProviderError("retryable", "bKash's answer could not be read.", { code: "bkash.unreadable" });
    const ttlSeconds = Math.floor(Number(field(reply.answer, "expires_in"))) - TOKEN_MARGIN_SECONDS;
    if (Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60) await ctx.kv.set(await tokenKey(), token, { ttlSeconds });
    return token;
  }

  const authorized = (token: string) => ({ Authorization: token, "X-APP-Key": credentials.appKey });

  return {
    environment: credentials.environment,

    async authenticate() {
      await grant();
    },

    async post(path, body, { mutating }) {
      const key = await tokenKey();
      const cached = await ctx.kv.get<string>(key);
      const fromCache = typeof cached === "string" && cached.length > 0;
      const reply = await send(path, body, authorized(fromCache ? cached : await grant()), mutating);
      if (reply !== "unauthorized") return reply;
      if (!fromCache) throw credentialsRefused();
      // bKash refused a cached token (expired or revoked early) before doing anything: grant a new one and send once more.
      await ctx.kv.delete(key);
      const retried = await send(path, body, authorized(await grant()), mutating);
      if (retried === "unauthorized") throw credentialsRefused();
      return retried;
    },
  };
}
