// BDBulkSMS (GreenWeb) behind the SMS port.
// API docs: https://api.bdbulksms.net — token auth, JSON POST.

import { smsCredentialIssue } from "../credentials";
import type { SmsAdapter } from "../port";
import { classifySmsProviderFailure, sanitizeSmsProviderDiagnostic } from "../retryability";

export interface BdBulkSmsSettings {
  token: string;
}

export const bdBulkSms: SmsAdapter<BdBulkSmsSettings> = {
  id: "bdbulksms",
  label: "BDBulkSMS (GreenWeb)",

  configure(stored) {
    const token = stored.value.bdbulksmsToken;
    const error = smsCredentialIssue(stored, "bdbulksmsToken", [["BDBulkSMS token", token]])
      ?? (!token ? "BDBulkSMS token is required" : null);
    return error ? { error } : { settings: { token } };
  },

  async send(input, { settings }) {
    // BDBulkSMS accepts +8801XXXXXXXXX directly — no stripping needed
    const res = await fetch("https://api.bdbulksms.net/api.php?json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: settings.token,
        smsdata: [{ to: input.to, message: input.message }],
      }),
    });

    const text = await res.text();
    let json: Array<{ to: string; status: string; statusmsg: string }>;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        success: false,
        rawStatus: `HTTP ${res.status}: unreadable provider response`,
        retryable: classifySmsProviderFailure(undefined, res.status),
      };
    }

    const first = json[0];
    if (res.ok && first?.status === "SENT") {
      return {
        success: true,
        providerRef: input.clientReference,
        rawStatus: sanitizeSmsProviderDiagnostic(first.statusmsg),
      };
    }
    const rawStatus = first?.statusmsg ?? "Unknown error";
    return {
      success: false,
      rawStatus: sanitizeSmsProviderDiagnostic(rawStatus),
      retryable: classifySmsProviderFailure(rawStatus, res.ok ? undefined : res.status),
    };
  },
};
