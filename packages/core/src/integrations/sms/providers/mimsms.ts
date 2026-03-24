// src/integrations/sms/providers/mimsms.ts
// MIM SMS provider implementation.
// API docs: https://api.mimsms.com — username + API key auth, JSON POST.

import type { SmsProvider, SendSmsOptions, SendSmsResult } from "../provider";

export interface MimSmsConfig {
  userName: string; // Email address
  apiKey: string;
  senderName: string; // Registered sender ID — mandatory
}

export class MimSmsProvider implements SmsProvider {
  readonly name = "mimsms";

  constructor(private config: MimSmsConfig) {}

  validateConfig(): string | null {
    if (!this.config.userName)
      return "MIM SMS username (email) is required";
    if (!this.config.apiKey) return "MIM SMS API key is required";
    if (!this.config.senderName)
      return "MIM SMS sender name is required (must be registered with MIM SMS)";
    return null;
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    // Strip + prefix: +8801XXXXXXXXX -> 8801XXXXXXXXX
    const to = options.to.replace(/^\+/, "");

    const res = await fetch("https://api.mimsms.com/api/SmsSending/SMS", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        UserName: this.config.userName,
        Apikey: this.config.apiKey,
        MobileNumber: to,
        CampaignId: "null",
        SenderName: this.config.senderName,
        TransactionType: "T", // Transactional — required for OTP
        Message: options.message,
      }),
    });

    const text = await res.text();
    let json: { statusCode: string; status: string; trxnId: string; responseResult: string };
    try {
      json = JSON.parse(text);
    } catch {
      return { success: false, rawStatus: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    if (json.statusCode === "200" && json.status === "Success") {
      return {
        success: true,
        providerRef: json.trxnId,
        rawStatus: json.responseResult,
      };
    }
    return {
      success: false,
      rawStatus: `${json.statusCode}: ${json.responseResult}`,
    };
  }
}
