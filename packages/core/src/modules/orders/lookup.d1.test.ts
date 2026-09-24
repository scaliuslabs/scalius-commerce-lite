// Public "Track your order" on the real schema: the code goes only to the
// contact saved on the order, the buyer is told where it went (or that none
// can reach them), and a correct code issues a normal private receipt proof.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { NotFoundError, RateLimitError } from "../../errors";
import { deriveCustomerAuthOtpDeliveryCode } from "../customers/customer-auth.service";
import { sendOrderLookupOtp, verifyOrderLookupOtp } from "./lookup";
import { NoOrderCodeChannelError } from "./payment-recovery";
import { validateOrderReceiptProof } from "./receipts";

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
  it("sends a code to the email saved on the order, says where, and opens the receipt after the code", async () => {
    const sent = await send("#orderwithemail01", "০১৭১২-০০০০০১");
    expect(sent).toMatchObject({
      message: "We sent a code to b•••@example.test.",
      destination: "b•••@example.test",
      channel: "email",
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

  it("never claims a code was sent when none can arrive (R2-BA-03)", async () => {
    // A phone-only order while the store can't text: say so, send nothing.
    await expect(send("ORDERNOEMAIL0001", "01712000002")).rejects.toBeInstanceOf(NoOrderCodeChannelError);
    await expect(send("ORDERNOEMAIL0001", "01712000002")).rejects.toMatchObject({
      status: 409,
      message: "This order has no email address, and this store can't send text messages, so we can't send you a code.",
    });
    // No match: a plain answer, nothing sent.
    await expect(send("ORDERWITHEMAIL01", "01712000009")).rejects.toBeInstanceOf(NotFoundError);
    await expect(send("NOSUCHORDER00001", "01712000001")).rejects.toThrow("We couldn't find an order with that number and phone number.");
    expect(challenges()).toBe(0);
  });

  it("limits lookups per order number and per phone, and validates input", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await send("NOSUCHORDER00001", `017120000${10 + attempt}`).catch(() => undefined);
    }
    await expect(send("NOSUCHORDER00001", "01712000029")).rejects.toBeInstanceOf(RateLimitError);
    await expect(send("#abc", "01712000001")).rejects.toThrow("Enter your order number");
    await expect(send("ORDERWITHEMAIL01", "12345")).rejects.toThrow("Enter the phone number used for the order.");
  });
});
