// Public "Track your order" on the real schema: the code goes only to the
// contact saved on the order, lookups never reveal whether an order exists,
// and a correct code issues a normal private receipt proof.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { RateLimitError, ServiceUnavailableError } from "../../errors";
import { deriveCustomerAuthOtpDeliveryCode } from "../customers/customer-auth.service";
import { ORDER_LOOKUP_SENT_MESSAGE, sendOrderLookupOtp, verifyOrderLookupOtp } from "./order-lookup";
import { validateOrderReceiptProof } from "./order-receipts";

const KEY = Buffer.alloc(32, 9).toString("base64");
const emailEnv = { EMAIL: { send: vi.fn(async () => ({ messageId: "m" })) } };

let sqlite: DatabaseSync;
let db: Database;
let ip = 0;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO settings (id, key, value, type, category)
      VALUES ('email', 'document', '{"provider":"cloudflare","sender":"shop@example.test","resendApiKey":""}', 'json', 'email');
    INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, total_amount_minor, balance_due_minor)
      VALUES ('ORDERWITHEMAIL01', 'Buyer', '+8801712000001', 'Buyer@Example.test', 'House 1', 'c', 'z', 10000, 10000),
             ('ORDERNOEMAIL0001', 'Buyer', '+8801712000002', NULL, 'House 2', 'c', 'z', 10000, 10000);
  `);
});
afterEach(() => sqlite.close());

const send = (reference: string, phone: string, env: Record<string, unknown> = emailEnv) => sendOrderLookupOtp(db, {
  reference, phone, ip: `203.0.113.${++ip}`, emailEnv: env, encryptionKey: KEY, credentialEncryptionKey: KEY,
});
const challenges = () => Number(sqlite.prepare("SELECT COUNT(*) AS n FROM order_payment_recovery_challenges").get()?.n);

describe("track your order", () => {
  it("sends a code to the email saved on the order and opens the receipt after the code", async () => {
    const sent = await send("#orderwithemail01", "০১৭১২-০০০০০১");
    expect(sent).toMatchObject({
      message: ORDER_LOOKUP_SENT_MESSAGE,
      queuePayload: { type: "auth.send_otp", purpose: "order_lookup", method: "email", channel: "email" },
    });
    expect(JSON.stringify(sent.queuePayload)).not.toMatch(/buyer@example|8801712000001/i);
    const code = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: sent.challengeKey!, deliveryKey: sent.deliveryKey!, encryptionKey: KEY,
    });

    // The code only works together with the phone on the order.
    await expect(verifyOrderLookupOtp(db, { reference: "ORDERWITHEMAIL01", phone: "01712000009", code, encryptionKey: KEY }))
      .rejects.toThrow("That code isn't right.");
    const wrong = code === "111111" ? "222222" : "111111";
    await expect(verifyOrderLookupOtp(db, { reference: "ORDERWITHEMAIL01", phone: "01712000001", code: wrong, encryptionKey: KEY }))
      .rejects.toMatchObject({ details: { attemptsLeft: 4 } });

    const verified = await verifyOrderLookupOtp(db, { reference: "ORDERWITHEMAIL01", phone: "+880 1712 000001", code, encryptionKey: KEY });
    expect(verified.orderId).toBe("ORDERWITHEMAIL01");
    await expect(validateOrderReceiptProof(db, { orderId: "ORDERWITHEMAIL01", token: verified.receiptToken }))
      .resolves.toMatchObject({ orderId: "ORDERWITHEMAIL01" });
    await expect(verifyOrderLookupOtp(db, { reference: "ORDERWITHEMAIL01", phone: "01712000001", code, encryptionKey: KEY }))
      .rejects.toThrow("That code was already used.");
  });

  it("answers the same way whether or not the details match an order", async () => {
    const wrongPhone = await send("ORDERWITHEMAIL01", "01712000009");
    const unknownOrder = await send("NOSUCHORDER00001", "01712000001");
    const noReachableContact = await send("ORDERNOEMAIL0001", "01712000002");
    for (const result of [wrongPhone, unknownOrder, noReachableContact]) {
      expect(result).toEqual({ message: ORDER_LOOKUP_SENT_MESSAGE, resendAfterSeconds: 60, queuePayload: null });
    }
    expect(challenges()).toBe(0);
  });

  it("limits lookups per order number and per phone, and fails closed with no delivery channel", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await send("NOSUCHORDER00001", `0171200001${attempt}`);
    }
    await expect(send("NOSUCHORDER00001", "01712000019")).rejects.toBeInstanceOf(RateLimitError);
    await expect(send("#abc", "01712000001")).rejects.toThrow("Enter your order number");
    await expect(send("ORDERWITHEMAIL01", "12345")).rejects.toThrow("Enter the phone number used for the order.");
    await expect(send("ORDERWITHEMAIL01", "01712000001", {})).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});
