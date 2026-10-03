// GenNet iSMS behind the SMS port.
// API docs: <domain>/api/v3/ — account-specific domain, api_token auth, JSON POST.

import { smsCredentialIssue } from "../credentials";
import type { SmsAdapter } from "../port";
import { classifySmsProviderFailure, sanitizeSmsProviderDiagnostic } from "../retryability";

export interface GennetSettings {
  apiToken: string;
  /** Account-specific domain (e.g., "https://subdomain.gennet.com.bd"). */
  baseUrl: string;
  /** Brand/masking sender ID assigned by GenNet. */
  sid: string;
}

function baseUrlIssue(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return "Gennet base URL must be an absolute HTTPS URL without credentials, query parameters, or a fragment";
    }
    return null;
  } catch {
    return "Gennet base URL must be a valid absolute HTTPS URL";
  }
}

export const gennetSms: SmsAdapter<GennetSettings> = {
  id: "gennet",
  label: "GenNet iSMS",

  configure(stored) {
    const { gennetApiToken: apiToken, gennetBaseUrl: baseUrl, gennetSid: sid } = stored.value;
    const error = smsCredentialIssue(stored, "gennetApiToken", [
      ["GenNet API token", apiToken],
      ["GenNet base URL", baseUrl],
      ["GenNet SID", sid],
    ])
      ?? (!apiToken ? "Gennet API token is required" : null)
      ?? (!baseUrl ? "Gennet base URL is required" : null)
      ?? (!sid ? "Gennet SID (sender ID) is required" : null)
      ?? baseUrlIssue(baseUrl);
    return error ? { error } : { settings: { apiToken, baseUrl, sid } };
  },

  async send(input, { settings }) {
    // Strip + prefix: +8801XXXXXXXXX -> 8801XXXXXXXXX
    const msisdn = input.to.replace(/^\+/, "");

    // csms_id must be unique per day. Use a deterministic caller reference
    // when available so provider retries dedupe the same logical message.
    const csmsId = normalizeCsmsId(input.clientReference);

    const url = `${settings.baseUrl.replace(/\/$/, "")}/api/v3/send-sms`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: settings.apiToken,
        sid: settings.sid,
        msisdn,
        sms: input.message,
        csms_id: csmsId,
      }),
    });

    const text = await res.text();
    let json: {
      status: string;
      status_code: number;
      error_message: string;
      smsinfo: Array<{
        sms_status: string;
        reference_id: string;
        csms_id: string;
      }>;
    };
    try {
      json = JSON.parse(text);
    } catch {
      return {
        success: false,
        rawStatus: `HTTP ${res.status}: unreadable provider response`,
        retryable: classifySmsProviderFailure(undefined, res.status),
      };
    }

    // Duplicate csms_id (4023) means already sent — treat as success on retry
    if (res.ok && json.status === "SUCCESS" && json.status_code === 200) {
      const ref = json.smsinfo?.[0]?.reference_id ?? csmsId;
      return { success: true, providerRef: ref, rawStatus: "SUCCESS" };
    }
    if (res.ok && json.status_code === 4023) {
      return {
        success: true,
        providerRef: csmsId,
        rawStatus: "Duplicate csms_id - already sent",
      };
    }
    const rawStatus = `${json.status_code}: ${json.error_message}`;
    return {
      success: false,
      rawStatus: sanitizeSmsProviderDiagnostic(rawStatus),
      retryable: classifySmsProviderFailure(rawStatus, res.ok ? undefined : res.status),
    };
  },
};

function normalizeCsmsId(clientReference?: string): string {
  const cleaned = (clientReference ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 20);

  if (cleaned.length > 0) {
    return cleaned;
  }

  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  }

  return Date.now().toString(36).slice(0, 20);
}
