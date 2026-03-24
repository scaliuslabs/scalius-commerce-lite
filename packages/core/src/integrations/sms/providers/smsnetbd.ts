// src/integrations/sms/providers/smsnetbd.ts
// SMS.net.bd provider implementation.
// API docs: https://api.sms.net.bd — single API key auth, form-data POST.

import type { SmsProvider, SendSmsOptions, SendSmsResult } from "../provider";

export interface SmsNetBdConfig {
  apiKey: string;
  senderId?: string; // Optional — if approved sender ID exists
}

export class SmsNetBdProvider implements SmsProvider {
  readonly name = "smsnetbd";

  constructor(private config: SmsNetBdConfig) {}

  validateConfig(): string | null {
    if (!this.config.apiKey) return "SMS.net.bd API key is required";
    return null;
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    // Strip + prefix: +8801XXXXXXXXX -> 8801XXXXXXXXX
    const to = options.to.replace(/^\+/, "");

    const form = new FormData();
    form.append("api_key", this.config.apiKey);
    form.append("msg", options.message);
    form.append("to", to);
    if (this.config.senderId) form.append("sender_id", this.config.senderId);

    const res = await fetch("https://api.sms.net.bd/sendsms", {
      method: "POST",
      body: form,
    });

    const text = await res.text();
    let json: { error: number; msg: string; data?: { request_id?: number } };
    try {
      json = JSON.parse(text);
    } catch {
      return { success: false, rawStatus: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    if (json.error === 0) {
      return {
        success: true,
        providerRef: String(json.data?.request_id ?? ""),
        rawStatus: json.msg,
      };
    }
    return { success: false, rawStatus: `error=${json.error}: ${json.msg}` };
  }
}
