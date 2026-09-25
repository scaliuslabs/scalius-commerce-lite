// Public "Track your order" on the real schema: the order number alone finds
// the order; a code goes only through a channel the store chose in Customer
// accounts, to the contact saved on the order; a correct code issues a normal
// private receipt proof. A chosen channel that can't send fails closed.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { NotFoundError, RateLimitError } from "../../errors";
import { deriveCustomerAuthOtpDeliveryCode } from "../customers/customer-auth.service";
import {
  NoOrderCodeChannelError,
  OrderCodeChannelUnavailableError,
  listOrderCodeOptions,
} from "../customers/customer-code-channels";
import { customerAuthDocument } from "../settings/documents";
import { findOrderByReference, sendOrderLookupOtp, verifyOrderLookupOtp } from "./lookup";
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
    INSERT INTO orders (id, customer_name, customer_phone, customer_email, customer_whatsapp, shipping_address, city, zone, total_amount_minor, balance_due_minor)
      VALUES ('ORDERWITHEMAIL01', 'Buyer', '+8801712000001', 'Buyer@Example.test', NULL, 'House 1', 'c', 'z', 10000, 10000),
             ('ORDERNOEMAIL0001', 'Buyer', '+8801712000002', NULL, '+8801812000002', 'House 2', 'c', 'z', 10000, 10000);
  `);
});
afterEach(() => sqlite.close());

const send = (reference: string, channel?: "email" | "sms" | "whatsapp") => sendOrderLookupOtp(db, {
  reference, channel, ip: `203.0.113.${++ip}`, emailEnv, encryptionKey: KEY, credentialEncryptionKey: KEY,
});
const challenges = () => Number(sqlite.prepare("SELECT COUNT(*) AS n FROM order_payment_recovery_challenges").get()?.n);

describe("track your order", () => {
  it("sends a code to the email saved on the order and opens the receipt with the order number and code alone", async () => {
    const sent = await send("#orderwithemail01");
    expect(sent).toMatchObject({
      message: "We sent a code to b•••@example.test.",
      destination: "b•••@example.test",
      channel: "email",
      queuePayload: { type: "auth.send_otp", purpose: "order_lookup", method: "email", channel: "email" },
    });
    expect(JSON.stringify(sent.queuePayload)).not.toMatch(/buyer@example|8801712000001|"code"|identifier/i);
    const code = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: sent.challengeKey!, deliveryKey: sent.deliveryKey!, encryptionKey: KEY,
    });

    const wrong = code === "111111" ? "222222" : "111111";
    await expect(verifyOrderLookupOtp(db, { reference: "ORDERWITHEMAIL01", code: wrong, encryptionKey: KEY }))
      .rejects.toMatchObject({ details: { attemptsLeft: 4 } });
    const verified = await verifyOrderLookupOtp(db, { reference: "ORDERWITHEMAIL01", code, encryptionKey: KEY });
    expect(verified.orderId).toBe("ORDERWITHEMAIL01");
    await expect(validateOrderReceiptProof(db, { orderId: "ORDERWITHEMAIL01", token: verified.receiptToken }))
      .resolves.toMatchObject({ orderId: "ORDERWITHEMAIL01" });
    await expect(verifyOrderLookupOtp(db, { reference: "ORDERWITHEMAIL01", code, encryptionKey: KEY }))
      .rejects.toThrow("That code was already used.");
  });

  it("never sends through a channel the store didn't choose, and says when none reaches the order", async () => {
    // Email only (the default), and this order has no email: nothing can go out.
    await expect(send("ORDERNOEMAIL0001")).rejects.toBeInstanceOf(NoOrderCodeChannelError);
    expect(listOrderCodeOptions(await customerAuthDocument.read(db), (await findOrderByReference(db, "ORDERNOEMAIL0001"))!))
      .toEqual([]);
    // A missing order is the same plain answer as any other miss.
    await expect(send("NOSUCHORDER00001")).rejects.toBeInstanceOf(NotFoundError);
    expect(challenges()).toBe(0);
  });

  it("fails closed when the chosen channel can't send, instead of falling back to email", async () => {
    await customerAuthDocument.write(db, { email: "optional", whatsapp: "separate", channels: ["sms", "email", "whatsapp"] });
    // SMS has no provider here; email could send, but the buyer asked for SMS.
    await expect(send("ORDERWITHEMAIL01", "sms")).rejects.toBeInstanceOf(OrderCodeChannelUnavailableError);
    await expect(send("ORDERWITHEMAIL01")).rejects.toThrow("Text message codes aren't available right now.");
    await expect(send("ORDERWITHEMAIL01", "email")).resolves.toMatchObject({ channel: "email" });
    // WhatsApp codes go to the separate WhatsApp number saved on the order.
    expect(listOrderCodeOptions(await customerAuthDocument.read(db), (await findOrderByReference(db, "ORDERNOEMAIL0001"))!))
      .toEqual([
        { channel: "sms", destination: "01•••••002" },
        { channel: "whatsapp", destination: "01•••••002" },
      ]);
  });

  it("limits code requests per order number and validates input", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await send("NOSUCHORDER00001").catch(() => undefined);
    }
    await expect(send("NOSUCHORDER00001")).rejects.toBeInstanceOf(RateLimitError);
    await expect(send("#abc")).rejects.toThrow("Enter your order number");
  });
});
