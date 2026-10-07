// The Bangladesh SMS gateways behind the SMS port: SMS.net.bd, BDBulkSMS
// (GreenWeb), MIM SMS and GenNet iSMS. Moved from core
// (packages/core/src/integrations/sms/providers/*) with the same requests,
// answers and retry rules; only the transport is the app's `ctx.http`.
//
// - The platform checks the provider's own settings before every send
//   (`providers.sms[].settings`: set, readable, not a placeholder) and calls
//   no gateway while one is missing. `requireText` repeats the check here.
// - A refusal is an answer (`success: false`), retryable only when the same
//   message can pass later. A request that could not complete (timeout,
//   network) throws a retryable `ProviderError`, `uncertain` because the
//   gateway may already have sent it; the platform retries it only with the
//   message's idempotency key (`clientReference`).
// - Answers keep no phone number, e-mail address or credential
//   (sms-diagnostics.ts), and nothing here logs a request or a response.

import { ProviderError, defineSmsProvider, type PluginContext, type PluginHttpResponse, type SmsSend, type SmsSendInput } from "@scalius/plugin-sdk";
import { multipartForm, optionalText, platformErrorCode, requireText } from "./common";
import { classifySmsProviderFailure, sanitizeSmsProviderDiagnostic } from "./sms-diagnostics";

/** The gateways' hosts (GenNet gives each account its own subdomain). */
export const SMS_HOSTS = ["api.sms.net.bd", "api.bdbulksms.net", "api.mimsms.com", "*.gennet.com.bd"] as const;

const SEND_TIMEOUT_MS = 15_000;

/** One POST; a request that could not complete is retryable and uncertain (the gateway may have sent it). */
async function post(ctx: PluginContext, gateway: string, url: string, init: { headers: Record<string, string>; body: string }): Promise<PluginHttpResponse> {
  try {
    return await ctx.http.fetch(url, { method: "POST", ...init, timeoutMs: SEND_TIMEOUT_MS });
  } catch (error) {
    const code = platformErrorCode(error);
    if (code === "http.not_allowed" || code === "http.invalid_request") {
      throw new ProviderError("misconfigured", `${gateway} cannot be reached at this address.`, { code: "bangladesh.sms_address" });
    }
    const timedOut = code === "http.timeout";
    throw new ProviderError("retryable", timedOut ? `${gateway} did not answer in time.` : `${gateway} could not be reached.`, {
      uncertain: true,
      code: timedOut ? "bangladesh.sms_timeout" : "bangladesh.sms_unreachable",
    });
  }
}

/** A gateway body that is not JSON: the HTTP status decides whether to try again. */
function unreadable(response: PluginHttpResponse): SmsSend {
  return {
    success: false,
    rawStatus: `HTTP ${response.status}: unreadable provider response`,
    retryable: classifySmsProviderFailure(undefined, response.status),
  };
}

async function readJson<T>(response: PluginHttpResponse): Promise<T | null> {
  try {
    return JSON.parse(await response.text()) as T;
  } catch {
    return null;
  }
}

function refused(rawStatus: string, response: PluginHttpResponse): SmsSend {
  return {
    success: false,
    rawStatus: sanitizeSmsProviderDiagnostic(rawStatus) ?? "provider_failure",
    retryable: classifySmsProviderFailure(rawStatus, response.ok ? undefined : response.status),
  };
}

function sent(providerRef: string | undefined, rawStatus: string | undefined): SmsSend {
  const status = sanitizeSmsProviderDiagnostic(rawStatus);
  return { success: true, ...(providerRef ? { providerRef } : {}), ...(status ? { rawStatus: status } : {}) };
}

/** +8801XXXXXXXXX → 8801XXXXXXXXX, as SMS.net.bd, MIM SMS and GenNet take it. */
const withoutPlus = (to: string) => to.replace(/^\+/, "");

// ── SMS.net.bd: one API key, multipart form POST ─────────────────────────

export async function sendSmsNetBd(input: SmsSendInput, ctx: PluginContext): Promise<SmsSend> {
  const apiKey = requireText(ctx, "smsnetbd_api_key", "SMS.net.bd API key");
  const senderId = optionalText(ctx, "smsnetbd_sender_id");
  const fields: Array<[string, string]> = [["api_key", apiKey], ["msg", input.message], ["to", withoutPlus(input.to)]];
  if (senderId) fields.push(["sender_id", senderId]);
  const form = multipartForm(fields);
  const response = await post(ctx, "SMS.net.bd", "https://api.sms.net.bd/sendsms", {
    headers: { "Content-Type": form.contentType },
    body: form.body,
  });
  const json = await readJson<{ error: number; msg: string; data?: { request_id?: number } }>(response);
  if (!json) return unreadable(response);
  if (response.ok && json.error === 0) {
    const requestId = json.data?.request_id;
    return sent(requestId !== undefined && requestId !== null ? String(requestId) : undefined, json.msg);
  }
  return refused(`error=${json.error}: ${json.msg}`, response);
}

// ── BDBulkSMS (GreenWeb): token, JSON POST ───────────────────────────────

export async function sendBdBulkSms(input: SmsSendInput, ctx: PluginContext): Promise<SmsSend> {
  const token = requireText(ctx, "bdbulksms_token", "BDBulkSMS token");
  // BDBulkSMS takes +8801XXXXXXXXX as it is.
  const response = await post(ctx, "BDBulkSMS", "https://api.bdbulksms.net/api.php?json", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, smsdata: [{ to: input.to, message: input.message }] }),
  });
  const json = await readJson<Array<{ to: string; status: string; statusmsg: string }>>(response);
  if (!json) return unreadable(response);
  const first = Array.isArray(json) ? json[0] : undefined;
  // The gateway gives no message id: the platform's reference is the receipt's, never the phone.
  if (response.ok && first?.status === "SENT") return sent(input.clientReference, first.statusmsg);
  return refused(first?.statusmsg ?? "Unknown error", response);
}

// ── MIM SMS: username + API key + registered sender name, JSON POST ──────

export async function sendMimSms(input: SmsSendInput, ctx: PluginContext): Promise<SmsSend> {
  const userName = requireText(ctx, "mimsms_username", "MIM SMS username (email)");
  const apiKey = requireText(ctx, "mimsms_api_key", "MIM SMS API key");
  const senderName = requireText(ctx, "mimsms_sender_name", "MIM SMS sender name");
  const response = await post(ctx, "MIM SMS", "https://api.mimsms.com/api/SmsSending/SMS", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      UserName: userName,
      Apikey: apiKey,
      MobileNumber: withoutPlus(input.to),
      CampaignId: "null",
      SenderName: senderName,
      TransactionType: "T", // Transactional: required for OTP.
      Message: input.message,
    }),
  });
  const json = await readJson<{ statusCode: string; status: string; trxnId: string; responseResult: string }>(response);
  if (!json) return unreadable(response);
  if (response.ok && json.statusCode === "200" && json.status === "Success") return sent(json.trxnId || undefined, json.responseResult);
  return refused(`${json.statusCode}: ${json.responseResult}`, response);
}

// ── GenNet iSMS: account domain + API token + SID, JSON POST ─────────────

/** Why a GenNet base URL cannot be used, or null. Its host must be a gennet.com.bd subdomain (the app's allowed hosts). */
export function gennetBaseUrlIssue(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return "Gennet base URL must be an absolute HTTPS URL without credentials, query parameters, or a fragment";
    }
    if (!parsed.hostname.toLowerCase().endsWith(".gennet.com.bd")) {
      return "Gennet base URL must be your account's address on gennet.com.bd";
    }
    return null;
  } catch {
    return "Gennet base URL must be a valid absolute HTTPS URL";
  }
}

/** csms_id is unique per day: the caller's deterministic reference, so a retry dedupes at GenNet. */
export function normalizeCsmsId(clientReference?: string): string {
  const cleaned = (clientReference ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  return cleaned.length > 0 ? cleaned : crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export async function sendGennet(input: SmsSendInput, ctx: PluginContext): Promise<SmsSend> {
  const apiToken = requireText(ctx, "gennet_api_token", "Gennet API token");
  const baseUrl = requireText(ctx, "gennet_base_url", "Gennet base URL");
  const sid = requireText(ctx, "gennet_sid", "Gennet SID (sender ID)");
  const issue = gennetBaseUrlIssue(baseUrl);
  if (issue) throw new ProviderError("misconfigured", `${issue}.`, { code: "bangladesh.gennet_base_url" });
  const csmsId = normalizeCsmsId(input.clientReference);
  const response = await post(ctx, "GenNet", `${baseUrl.replace(/\/$/, "")}/api/v3/send-sms`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, sid, msisdn: withoutPlus(input.to), sms: input.message, csms_id: csmsId }),
  });
  const json = await readJson<{ status: string; status_code: number; error_message: string; smsinfo?: Array<{ reference_id?: string }> }>(response);
  if (!json) return unreadable(response);
  if (response.ok && json.status === "SUCCESS" && json.status_code === 200) {
    return { success: true, providerRef: json.smsinfo?.[0]?.reference_id || csmsId, rawStatus: "SUCCESS" };
  }
  // A duplicate csms_id (4023): this message was already sent.
  if (response.ok && json.status_code === 4023) {
    return { success: true, providerRef: csmsId, rawStatus: "Duplicate csms_id - already sent" };
  }
  return refused(`${json.status_code}: ${json.error_message}`, response);
}

export const smsProviders = {
  smsnetbd: defineSmsProvider({ send: sendSmsNetBd }),
  bdbulksms: defineSmsProvider({ send: sendBdBulkSms }),
  mimsms: defineSmsProvider({ send: sendMimSms }),
  gennet: defineSmsProvider({ send: sendGennet }),
};
