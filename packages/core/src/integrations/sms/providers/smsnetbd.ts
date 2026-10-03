// SMS.net.bd behind the SMS port.
// API docs: https://api.sms.net.bd — single API key auth, form-data POST.

import { smsCredentialIssue } from "../credentials";
import type { SmsAdapter } from "../port";
import { classifySmsProviderFailure, sanitizeSmsProviderDiagnostic } from "../retryability";

export interface SmsNetBdSettings {
  apiKey: string;
  /** Optional: only when an approved sender ID exists. */
  senderId?: string;
}

export const smsNetBdSms: SmsAdapter<SmsNetBdSettings> = {
  id: "smsnetbd",
  label: "SMS.net.bd",

  configure(stored) {
    const { smsnetbdApiKey: apiKey, smsnetbdSenderId: senderId } = stored.value;
    const error = smsCredentialIssue(stored, "smsnetbdApiKey", [
      ["SMS.net.bd API key", apiKey],
      ["SMS.net.bd sender ID", senderId],
    ]) ?? (!apiKey ? "SMS.net.bd API key is required" : null);
    return error ? { error } : { settings: { apiKey, senderId: senderId || undefined } };
  },

  async send(input, { settings }) {
    // Strip + prefix: +8801XXXXXXXXX -> 8801XXXXXXXXX
    const to = input.to.replace(/^\+/, "");

    const form = new FormData();
    form.append("api_key", settings.apiKey);
    form.append("msg", input.message);
    form.append("to", to);
    if (settings.senderId) form.append("sender_id", settings.senderId);

    const res = await fetch("https://api.sms.net.bd/sendsms", {
      method: "POST",
      body: form,
    });

    const text = await res.text();
    let json: { error: number; msg: string; data?: { request_id?: number } };
    try {
      json = JSON.parse(text);
    } catch {
      return {
        success: false,
        rawStatus: `HTTP ${res.status}: unreadable provider response`,
        retryable: classifySmsProviderFailure(undefined, res.status),
      };
    }

    if (res.ok && json.error === 0) {
      const requestId = json.data?.request_id;
      return {
        success: true,
        ...(requestId !== undefined && requestId !== null ? { providerRef: String(requestId) } : {}),
        rawStatus: sanitizeSmsProviderDiagnostic(json.msg),
      };
    }
    const rawStatus = `error=${json.error}: ${json.msg}`;
    return {
      success: false,
      rawStatus: sanitizeSmsProviderDiagnostic(rawStatus),
      retryable: classifySmsProviderFailure(rawStatus, res.ok ? undefined : res.status),
    };
  },
};
