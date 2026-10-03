// MIM SMS behind the SMS port.
// API docs: https://api.mimsms.com — username + API key auth, JSON POST.

import { smsCredentialIssue } from "../credentials";
import type { SmsAdapter } from "../port";
import { classifySmsProviderFailure, sanitizeSmsProviderDiagnostic } from "../retryability";

export interface MimSmsSettings {
  /** Email address. */
  userName: string;
  apiKey: string;
  /** Registered sender ID — mandatory. */
  senderName: string;
}

export const mimSms: SmsAdapter<MimSmsSettings> = {
  id: "mimsms",
  label: "MIM SMS",

  configure(stored) {
    const { mimsmsUsername: userName, mimsmsApiKey: apiKey, mimsmsSenderName: senderName } = stored.value;
    const error = smsCredentialIssue(stored, "mimsmsApiKey", [
      ["MIM SMS username", userName],
      ["MIM SMS API key", apiKey],
      ["MIM SMS sender name", senderName],
    ])
      ?? (!userName ? "MIM SMS username (email) is required" : null)
      ?? (!apiKey ? "MIM SMS API key is required" : null)
      ?? (!senderName ? "MIM SMS sender name is required (must be registered with MIM SMS)" : null);
    return error ? { error } : { settings: { userName, apiKey, senderName } };
  },

  async send(input, { settings }) {
    // Strip + prefix: +8801XXXXXXXXX -> 8801XXXXXXXXX
    const to = input.to.replace(/^\+/, "");

    const res = await fetch("https://api.mimsms.com/api/SmsSending/SMS", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        UserName: settings.userName,
        Apikey: settings.apiKey,
        MobileNumber: to,
        CampaignId: "null",
        SenderName: settings.senderName,
        TransactionType: "T", // Transactional — required for OTP
        Message: input.message,
      }),
    });

    const text = await res.text();
    let json: { statusCode: string; status: string; trxnId: string; responseResult: string };
    try {
      json = JSON.parse(text);
    } catch {
      return {
        success: false,
        rawStatus: `HTTP ${res.status}: unreadable provider response`,
        retryable: classifySmsProviderFailure(undefined, res.status),
      };
    }

    if (res.ok && json.statusCode === "200" && json.status === "Success") {
      return {
        success: true,
        providerRef: json.trxnId,
        rawStatus: sanitizeSmsProviderDiagnostic(json.responseResult),
      };
    }
    const rawStatus = `${json.statusCode}: ${json.responseResult}`;
    return {
      success: false,
      rawStatus: sanitizeSmsProviderDiagnostic(rawStatus),
      retryable: classifySmsProviderFailure(rawStatus, res.ok ? undefined : res.status),
    };
  },
};
