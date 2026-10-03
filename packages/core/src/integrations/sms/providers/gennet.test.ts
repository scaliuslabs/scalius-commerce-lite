import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredSms } from "../port";
import { gennetSms } from "./gennet";

function stored(values: { gennetApiToken: string; gennetBaseUrl: string; gennetSid: string }): StoredSms {
  return {
    value: {
      activeProvider: "gennet",
      bdbulksmsToken: "",
      mimsmsUsername: "",
      mimsmsApiKey: "",
      mimsmsSenderName: "",
      smsnetbdApiKey: "",
      smsnetbdSenderId: "",
      ...values,
    },
    revision: 1,
    stored: true,
    invalid: false,
    secretErrors: {},
    secretsConfigured: {},
  };
}

describe("GenNet SMS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unsafe provider base URLs before dispatch", () => {
    expect(gennetSms.configure(stored({
      gennetApiToken: "merchant-token",
      gennetBaseUrl: "http://localhost:8787?token=secret",
      gennetSid: "BRAND",
    }))).toEqual({ error: expect.stringContaining("absolute HTTPS URL") });
  });

  it("uses the deterministic client reference as csms_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        status: "SUCCESS",
        status_code: 200,
        error_message: "",
        smsinfo: [{
          sms_status: "SUCCESS",
          reference_id: "gennet_ref_1",
          csms_id: "outboxsmsrecipientha",
        }],
      })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await gennetSms.send({
      to: "+8801700000000",
      message: "Order update",
      clientReference: "outbox_sms:recipient_hash",
    }, {
      settings: {
        apiToken: "token",
        baseUrl: "https://sms.example.com/",
        sid: "BRAND",
      },
    });

    expect(result).toMatchObject({
      success: true,
      providerRef: "gennet_ref_1",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      csms_id: "outboxsmsrecipientha",
    });
  });

  it("treats duplicate csms_id responses as successful retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        status: "FAILED",
        status_code: 4023,
        error_message: "Duplicate csms_id",
        smsinfo: [],
      })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await gennetSms.send({
      to: "+8801700000000",
      message: "Order update",
      clientReference: "outbox_sms:recipient_hash",
    }, {
      settings: {
        apiToken: "token",
        baseUrl: "https://sms.example.com",
        sid: "BRAND",
      },
    });

    expect(result).toMatchObject({
      success: true,
      providerRef: "outboxsmsrecipientha",
      rawStatus: "Duplicate csms_id - already sent",
    });
  });
});
