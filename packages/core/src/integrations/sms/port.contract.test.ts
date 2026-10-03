// The built-in SMS gateways keep the shared SMS port (the one app providers
// implement): what they are sent fits its input, and every answer, sent or
// refused or unreadable, fits its output, so callers handle every provider
// alike. Provider HTTP is mocked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_OPERATIONS, PROVIDER_PORTS } from "@scalius/shared/plugins/providers";
import { bindProvider } from "../provider-port";
import type { SmsAdapter } from "./port";
import { bdBulkSms } from "./providers/bdbulksms";
import { gennetSms } from "./providers/gennet";
import { mimSms } from "./providers/mimsms";
import { smsNetBdSms } from "./providers/smsnetbd";

const input = { to: "+8801712345678", message: "Your order shipped", clientReference: "outbox1smsrecipient" };

const CASES: Array<[string, SmsAdapter<unknown>, unknown, { sent: unknown; refused: unknown }]> = [
  ["SMS.net.bd", smsNetBdSms, { apiKey: "merchant-key" }, {
    sent: { error: 0, msg: "Request successfully submitted", data: { request_id: 7781 } },
    refused: { error: 405, msg: "Authorization required" },
  }],
  ["BDBulkSMS", bdBulkSms, { token: "merchant-token" }, {
    sent: [{ to: input.to, status: "SENT", statusmsg: "Sent" }],
    refused: [{ to: input.to, status: "FAILED", statusmsg: "Invalid token" }],
  }],
  ["MIM SMS", mimSms, { userName: "owner@shop.test", apiKey: "merchant-key", senderName: "SHOP" }, {
    sent: { statusCode: "200", status: "Success", trxnId: "T-1", responseResult: "Sent" },
    refused: { statusCode: "208", status: "Failed", trxnId: "", responseResult: "Insufficient balance" },
  }],
  ["GenNet", gennetSms, { apiToken: "merchant-token", baseUrl: "https://merchant.gennet.com.bd", sid: "SHOP" }, {
    sent: { status: "SUCCESS", status_code: 200, error_message: "", smsinfo: [{ sms_status: "SUCCESS", reference_id: "G-1", csms_id: "x" }] },
    refused: { status: "FAILED", status_code: 4001, error_message: "Invalid api token", smsinfo: [] },
  }],
];

function respond(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: status < 400, status, text: vi.fn().mockResolvedValue(body) }));
}

afterEach(() => vi.unstubAllGlobals());

describe.each(CASES)("%s keeps the SMS port", (_name, adapter, settings, answers) => {
  const provider = bindProvider("sms", adapter, settings);
  const port = PROVIDER_PORTS.sms;

  it("offers only the port's operations, send among them", () => {
    const operations: readonly string[] = [...PROVIDER_OPERATIONS.sms.required, ...PROVIDER_OPERATIONS.sms.optional];
    const offered = Object.keys(provider).filter((key) => key !== "id" && key !== "label");
    expect(offered).toContain("send");
    expect(offered.every((operation) => operations.includes(operation))).toBe(true);
    expect(port.send.input.safeParse(input).success).toBe(true);
  });

  it("answers a sent message within the port", async () => {
    respond(200, JSON.stringify(answers.sent));
    const result = await provider.send(input, {});
    expect(port.send.output.parse(result)).toMatchObject({ success: true });
  });

  it("answers a refused message within the port, never retrying what cannot pass", async () => {
    respond(200, JSON.stringify(answers.refused));
    const result = await provider.send(input, {});
    expect(port.send.output.parse(result)).toMatchObject({ success: false, retryable: false });
    expect(JSON.stringify(result)).not.toContain("8801712345678");
  });

  it("answers an unreadable provider response within the port, retryable on a server error", async () => {
    respond(502, "<html>Bad gateway</html>");
    const result = await provider.send(input, {});
    expect(port.send.output.parse(result)).toEqual({ success: false, rawStatus: "HTTP 502: unreadable provider response", retryable: true });
  });
});
