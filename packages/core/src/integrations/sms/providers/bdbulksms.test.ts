import { afterEach, describe, expect, it, vi } from "vitest";
import { bdBulkSms } from "./bdbulksms";

describe("BDBulkSMS diagnostics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never retains the recipient phone as a provider reference", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify([{
        to: "+8801712345678",
        status: "SENT",
        statusmsg: "Sent to +8801712345678",
      }])),
    }));
    const result = await bdBulkSms.send({
      to: "+8801712345678",
      message: "Order update",
      clientReference: "receipt_safe_reference",
    }, { settings: { token: "merchant-token-4821" } });

    expect(result).toMatchObject({
      success: true,
      providerRef: "receipt_safe_reference",
      rawStatus: "Sent to [phone]",
    });
    expect(JSON.stringify(result)).not.toContain("8801712345678");
  });
});
