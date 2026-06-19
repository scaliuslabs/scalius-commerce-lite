import { afterEach, describe, expect, it, vi } from "vitest";
import { GennetProvider } from "./gennet";

describe("GennetProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the deterministic client reference as csms_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
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

    const provider = new GennetProvider({
      apiToken: "token",
      baseUrl: "https://sms.example.com/",
      sid: "BRAND",
    });

    const result = await provider.sendSms({
      to: "+8801700000000",
      message: "Order update",
      clientReference: "outbox_sms:recipient_hash",
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
      text: vi.fn().mockResolvedValue(JSON.stringify({
        status: "FAILED",
        status_code: 4023,
        error_message: "Duplicate csms_id",
        smsinfo: [],
      })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GennetProvider({
      apiToken: "token",
      baseUrl: "https://sms.example.com",
      sid: "BRAND",
    });

    const result = await provider.sendSms({
      to: "+8801700000000",
      message: "Order update",
      clientReference: "outbox_sms:recipient_hash",
    });

    expect(result).toMatchObject({
      success: true,
      providerRef: "outboxsmsrecipientha",
      rawStatus: "Duplicate csms_id - already sent",
    });
  });
});
