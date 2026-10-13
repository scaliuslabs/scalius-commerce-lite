// The Bangladesh SMS gateways over the SDK harness (the platform's runtime,
// inputs and answers validated against the SMS port). Gateway HTTP is
// scripted.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import pack from "./index";
import { classifySmsProviderFailure, isRetryableSmsHttpStatus, sanitizeSmsProviderDiagnostic } from "./sms-diagnostics";

const input = { to: "+8801712345678", message: "Your order shipped", clientReference: "outbox1smsrecipient" };

interface Call { url: string; headers: Record<string, string>; body: string }
type Reply = { status: number; body: string } | Error;

function harness(settings: Record<string, string>, reply: Reply | ((call: Call) => Reply)) {
  const calls: Call[] = [];
  const instance = createPluginTestHarness(pack, {
    settings,
    fetch: (url, init) => {
      const request = init as { headers: Record<string, string>; body: string };
      const call = { url, headers: request.headers, body: request.body };
      calls.push(call);
      const answer = typeof reply === "function" ? reply(call) : reply;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { instance, calls };
}

const json = (body: unknown, status = 200): Reply => ({ status, body: JSON.stringify(body) });

const CASES: Array<[string, string, Record<string, string>, { sent: unknown; refused: unknown }]> = [
  ["SMS.net.bd", "smsnetbd", { smsnetbd_api_key: "merchant-key" }, {
    sent: { error: 0, msg: "Request successfully submitted", data: { request_id: 7781 } },
    refused: { error: 405, msg: "Authorization required" },
  }],
  ["BDBulkSMS", "bdbulksms", { bdbulksms_token: "merchant-token" }, {
    sent: [{ to: input.to, status: "SENT", statusmsg: "Sent" }],
    refused: [{ to: input.to, status: "FAILED", statusmsg: "Invalid token" }],
  }],
  ["MIM SMS", "mimsms", { mimsms_username: "owner@shop.test", mimsms_api_key: "merchant-key", mimsms_sender_name: "SHOP" }, {
    sent: { statusCode: "200", status: "Success", trxnId: "T-1", responseResult: "Sent" },
    refused: { statusCode: "208", status: "Failed", trxnId: "", responseResult: "Insufficient balance" },
  }],
  ["GenNet", "gennet", { gennet_api_token: "merchant-token", gennet_base_url: "https://merchant.gennet.com.bd", gennet_sid: "SHOP" }, {
    sent: { status: "SUCCESS", status_code: 200, error_message: "", smsinfo: [{ sms_status: "SUCCESS", reference_id: "G-1", csms_id: "x" }] },
    refused: { status: "FAILED", status_code: 4001, error_message: "Invalid api token", smsinfo: [] },
  }],
];

describe.each(CASES)("%s keeps the SMS port", (_name, provider, settings, answers) => {
  it("answers a sent message within the port", async () => {
    const { instance } = harness(settings, json(answers.sent));
    const result = await instance.provider(provider, "send", input);
    expect(result).toMatchObject({ ok: true, value: { success: true } });
  });

  it("answers a refused message within the port, never retrying what cannot pass", async () => {
    const { instance } = harness(settings, json(answers.refused));
    const result = await instance.provider(provider, "send", input);
    expect(result).toMatchObject({ ok: true, value: { success: false, retryable: false } });
    expect(JSON.stringify(result)).not.toContain("8801712345678");
  });

  it("answers an unreadable provider response within the port, retryable on a server error", async () => {
    const { instance } = harness(settings, { status: 502, body: "<html>Bad gateway</html>" });
    const result = await instance.provider(provider, "send", input);
    expect(result.value).toEqual({ success: false, rawStatus: "HTTP 502: unreadable provider response", retryable: true });
  });

  it("throws a retryable, uncertain error when the gateway does not answer, and logs nothing about the message", async () => {
    const { instance } = harness(settings, Object.assign(new Error("[http.timeout] The request timed out."), { code: "http.timeout" }));
    const result = await instance.provider(provider, "send", input);
    expect(result).toMatchObject({ ok: false, error: { category: "retryable", uncertain: true } });
    expect(JSON.stringify([result, instance.logs])).not.toMatch(/8801712345678|merchant-(?:key|token)/);
  });

  it("refuses to send without its settings (misconfigured, no request)", async () => {
    const { instance, calls } = harness({}, json(answers.sent));
    const result = await instance.provider(provider, "send", input);
    expect(result).toMatchObject({ ok: false, error: { category: "misconfigured" } });
    expect(calls).toHaveLength(0);
  });
});

describe("gateway requests", () => {
  it("SMS.net.bd gets a multipart form with the number without its plus", async () => {
    const { instance, calls } = harness({ smsnetbd_api_key: "merchant-key", smsnetbd_sender_id: "SHOP" }, json({ error: 0, msg: "ok", data: { request_id: 1 } }));
    await instance.provider("smsnetbd", "send", input);
    expect(calls[0]!.url).toBe("https://api.sms.net.bd/sendsms");
    const boundary = /boundary=(.+)$/.exec(calls[0]!.headers["Content-Type"]!)![1]!;
    expect(calls[0]!.body).toBe([
      `--${boundary}\r\nContent-Disposition: form-data; name="api_key"\r\n\r\nmerchant-key\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="msg"\r\n\r\nYour order shipped\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n8801712345678\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="sender_id"\r\n\r\nSHOP\r\n`,
      `--${boundary}--\r\n`,
    ].join(""));
  });

  it("BDBulkSMS never keeps the recipient phone as a provider reference", async () => {
    const { instance } = harness({ bdbulksms_token: "merchant-token-4821" }, json([{ to: "+8801712345678", status: "SENT", statusmsg: "Sent to +8801712345678" }]));
    const result = await instance.provider("bdbulksms", "send", { ...input, clientReference: "receipt_safe_reference" });
    expect(result.value).toMatchObject({ success: true, providerRef: "receipt_safe_reference", rawStatus: "Sent to [phone]" });
    expect(JSON.stringify(result)).not.toContain("8801712345678");
  });

  it("MIM SMS sends a transactional message from the registered sender", async () => {
    const { instance, calls } = harness(
      { mimsms_username: "owner@shop.test", mimsms_api_key: "merchant-key", mimsms_sender_name: "SHOP" },
      json({ statusCode: "200", status: "Success", trxnId: "T-1", responseResult: "Sent" }),
    );
    await instance.provider("mimsms", "send", input);
    expect(JSON.parse(calls[0]!.body)).toEqual({
      UserName: "owner@shop.test", Apikey: "merchant-key", MobileNumber: "8801712345678", CampaignId: "null", SenderName: "SHOP", TransactionType: "T", Message: "Your order shipped",
    });
  });

  it("GenNet uses the deterministic client reference as csms_id", async () => {
    const settings = { gennet_api_token: "token", gennet_base_url: "https://sms.gennet.com.bd/", gennet_sid: "BRAND" };
    const { instance, calls } = harness(settings, json({ status: "SUCCESS", status_code: 200, error_message: "", smsinfo: [{ sms_status: "SUCCESS", reference_id: "gennet_ref_1", csms_id: "outboxsmsrecipientha" }] }));
    const result = await instance.provider("gennet", "send", { to: "+8801700000000", message: "Order update", clientReference: "outbox_sms:recipient_hash" });
    expect(result.value).toMatchObject({ success: true, providerRef: "gennet_ref_1" });
    expect(calls[0]!.url).toBe("https://sms.gennet.com.bd/api/v3/send-sms");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ csms_id: "outboxsmsrecipientha", msisdn: "8801700000000" });
  });

  it("GenNet treats a duplicate csms_id as an earlier send of this message", async () => {
    const { instance } = harness(
      { gennet_api_token: "token", gennet_base_url: "https://sms.gennet.com.bd", gennet_sid: "BRAND" },
      json({ status: "FAILED", status_code: 4023, error_message: "Duplicate csms_id", smsinfo: [] }),
    );
    const result = await instance.provider("gennet", "send", { to: "+8801700000000", message: "Order update", clientReference: "outbox_sms:recipient_hash" });
    expect(result.value).toMatchObject({ success: true, providerRef: "outboxsmsrecipientha", rawStatus: "Duplicate csms_id - already sent" });
  });

  it("GenNet refuses an address that is not https on gennet.com.bd before any request", async () => {
    for (const address of ["http://merchant.gennet.com.bd", "https://sms.example.com"]) {
      const { instance, calls } = harness({ gennet_api_token: "token", gennet_base_url: address, gennet_sid: "BRAND" }, json({}));
      const result = await instance.provider("gennet", "send", input);
      expect(result).toMatchObject({ ok: false, error: { category: "misconfigured" } });
      expect(calls).toHaveLength(0);
    }
  });
});

describe("SMS diagnostics", () => {
  it("does not retry merchant-actionable credential or configuration failures", () => {
    expect(classifySmsProviderFailure("error=405: Authorization required")).toBe(false);
    expect(classifySmsProviderFailure("Invalid API key")).toBe(false);
    expect(classifySmsProviderFailure("Insufficient balance")).toBe(false);
    expect(classifySmsProviderFailure("Sender ID is not approved")).toBe(false);
  });

  it("retries transient provider and network failures", () => {
    expect(isRetryableSmsHttpStatus(500)).toBe(true);
    expect(isRetryableSmsHttpStatus(429)).toBe(true);
    expect(classifySmsProviderFailure("Gateway timeout")).toBe(true);
    expect(classifySmsProviderFailure("Temporary server unavailable")).toBe(true);
  });

  it("redacts recipient and credential material from kept diagnostics", () => {
    expect(sanitizeSmsProviderDiagnostic("Invalid mobile +8801712345678 token=provider-secret buyer@example.com"))
      .toBe("Invalid mobile [phone] token=[redacted] [email]");
  });
});
