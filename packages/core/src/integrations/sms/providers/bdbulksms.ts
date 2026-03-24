// src/integrations/sms/providers/bdbulksms.ts
// BDBulkSMS (GreenWeb) provider implementation.
// API docs: https://api.bdbulksms.net — token auth, JSON POST.

import type { SmsProvider, SendSmsOptions, SendSmsResult } from "../provider";

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
      return { success: false, rawStatus: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const first = json[0];
    if (first && first.status === "SENT") {
      return {
        success: true,
        providerRef: first.to,
        rawStatus: first.statusmsg,
      };
    }
    return { success: false, rawStatus: first?.statusmsg ?? "Unknown error" };
  }
}
