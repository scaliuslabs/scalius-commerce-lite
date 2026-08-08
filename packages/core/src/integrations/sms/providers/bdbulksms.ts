// src/integrations/sms/providers/bdbulksms.ts
// BDBulkSMS (GreenWeb) provider implementation.
// API docs: https://api.bdbulksms.net — token auth, JSON POST.

import type { SmsProvider, SendSmsOptions, SendSmsResult } from "../provider";
import { classifySmsProviderFailure, sanitizeSmsProviderDiagnostic } from "../retryability";

export interface BdBulkSmsConfig {
  token: string;
}

export class BdBulkSmsProvider implements SmsProvider {
  readonly name = "bdbulksms";

  constructor(private config: BdBulkSmsConfig) {}

  validateConfig(): string | null {
    if (!this.config.token) return "BDBulkSMS token is required";
    return null;
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    // BDBulkSMS accepts +8801XXXXXXXXX directly — no stripping needed
    const res = await fetch("https://api.bdbulksms.net/api.php?json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: this.config.token,
        smsdata: [{ to: options.to, message: options.message }],
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
        providerRef: options.clientReference,
        rawStatus: sanitizeSmsProviderDiagnostic(first.statusmsg),
      };
    }
    const rawStatus = first?.statusmsg ?? "Unknown error";
    return {
      success: false,
      rawStatus: sanitizeSmsProviderDiagnostic(rawStatus),
      retryable: classifySmsProviderFailure(rawStatus, res.ok ? undefined : res.status),
    };
  }
}
