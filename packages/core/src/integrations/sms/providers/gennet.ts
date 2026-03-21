// src/integrations/sms/providers/gennet.ts
// Gennet iSMS provider implementation.
// API docs: <domain>/api/v3/ — account-specific domain, api_token auth, JSON POST.

import type { SmsProvider, SendSmsOptions, SendSmsResult } from "../provider";

export interface GennetConfig {
  apiToken: string;
  baseUrl: string; // Account-specific domain (e.g., "https://subdomain.gennet.com.bd")
  sid: string; // Brand/masking sender ID assigned by GenNet
}

export class GennetProvider implements SmsProvider {
  readonly name = "gennet";

  constructor(private config: GennetConfig) {}

  validateConfig(): string | null {
    if (!this.config.apiToken) return "Gennet API token is required";
    if (!this.config.baseUrl) return "Gennet base URL is required";
    if (!this.config.sid) return "Gennet SID (sender ID) is required";
    return null;
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    // Strip + prefix: +8801XXXXXXXXX -> 8801XXXXXXXXX
    const msisdn = options.to.replace(/^\+/, "");

    // csms_id must be unique per day — use timestamp + random suffix
    const csmsId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(
      0,
      20,
    );

    const url = `${this.config.baseUrl.replace(/\/$/, "")}/api/v3/send-sms`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: this.config.apiToken,
        sid: this.config.sid,
        msisdn,
        sms: options.message,
        csms_id: csmsId,
      }),
    });

    const json = (await res.json()) as {
      status: string;
      status_code: number;
      error_message: string;
      smsinfo: Array<{
        sms_status: string;
        reference_id: string;
        csms_id: string;
      }>;
    };

    // Duplicate csms_id (4023) means already sent — treat as success on retry
    if (json.status === "SUCCESS" && json.status_code === 200) {
      const ref = json.smsinfo?.[0]?.reference_id ?? csmsId;
      return { success: true, providerRef: ref, rawStatus: "SUCCESS" };
    }
    if (json.status_code === 4023) {
      return {
        success: true,
        providerRef: csmsId,
        rawStatus: "Duplicate csms_id — already sent",
      };
    }
    return {
      success: false,
      rawStatus: `${json.status_code}: ${json.error_message}`,
    };
  }
}
