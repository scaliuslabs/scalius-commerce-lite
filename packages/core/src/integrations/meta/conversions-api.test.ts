import { describe, expect, it } from "vitest";

import { redactCapiPayloadForLog } from "./conversions-api";

describe("Meta Conversions API log redaction", () => {
  it("redacts user data, test event codes, and event source URL queries", () => {
    const redacted = redactCapiPayloadForLog({
      test_event_code: "TEST123",
      data: [
        {
          event_name: "Purchase",
          event_time: 1_800_000_000,
          event_source_url:
            "https://store.example/order-success?orderId=order_1&token=receipt_secret",
          event_id: "Purchase:order_1",
          action_source: "website",
          user_data: {
            em: ["hashed-email"],
            client_ip_address: "203.0.113.10",
            client_user_agent: "Browser",
            fbp: "fb.1.123",
          },
          custom_data: {
            order_id: "order_1",
            currency: "BDT",
            value: 1000,
          },
        },
      ],
    });

    expect(redacted).toMatchObject({
      test_event_code: "[redacted]",
      data: [
        {
          event_source_url: "https://store.example/order-success",
          user_data: {
            em: "[redacted]",
            client_ip_address: "[redacted]",
            client_user_agent: "[redacted]",
            fbp: "[redacted]",
          },
        },
      ],
    });
  });
});
