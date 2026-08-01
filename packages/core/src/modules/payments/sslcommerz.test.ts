import { describe, expect, it } from "vitest";

import {
  buildSSLCommerzTranId,
  parseSSLCommerzTranId,
  SSL_COMMERZ_TRAN_ID_MAX_LENGTH,
} from "./sslcommerz";

describe("SSLCommerz transaction IDs", () => {
  it("keeps legacy short order IDs readable", () => {
    const transactionId = buildSSLCommerzTranId(
      "A39K02",
      "deposit",
      "abc12345",
    );

    expect(transactionId).toBe("A39K02_deposit_ABC12345");
    expect(parseSSLCommerzTranId(transactionId)).toEqual({
      orderId: "A39K02",
      paymentType: "deposit",
      transactionId,
    });
  });

  it("round-trips new 80-bit order IDs within the provider limit", () => {
    const orderId = "01K2V8X7M4P3N6QT";
    const transactionId = buildSSLCommerzTranId(
      orderId,
      "deposit",
      "abc12345",
    );

    expect(transactionId).toBe(`${orderId}_DABC12345`);
    expect(transactionId.length).toBeLessThanOrEqual(
      SSL_COMMERZ_TRAN_ID_MAX_LENGTH,
    );
    expect(parseSSLCommerzTranId(transactionId)).toEqual({
      orderId,
      paymentType: "deposit",
      transactionId,
    });
  });
});
