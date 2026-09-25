// Buyer identity on the real migrated schema: verified identifiers own
// accounts, guest checkout contacts never block or change them.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/client";
import { createMigratedSqlite, createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ConflictError, RateLimitError, ValidationError } from "../../errors";
import { saveSmsSettings } from "../../integrations/sms";
import { getOrderDetails } from "../orders/admin/detail";
import { getOfferedCustomerIdentity } from "../settings/checkout-readiness";
import { customerAuthDocument } from "../settings/documents";
import { createAtomicCheckoutAttempt } from "../checkout/attempts";
import { commitStorefrontOrderPayload } from "../checkout/commit";
import type { StorefrontOrderCommitPayload } from "../orders/types";
import {
  createCustomer,
  deleteCustomer,
  getCustomerDetail,
  getCustomerOrders,
  listCustomers,
  restoreCustomer,
  updateCustomer,
} from "./customers.service";
import { linkVerifiedContactOrders } from "./customer-identity";
import {
  buildCustomerAuthOtpStorageKey,
  persistCustomerAuthOtpChallenge,
} from "./customer-auth-otp-challenges";
import {
  cleanupExpiredCustomerSessions,
  deleteCustomerSession,
  getAccountPhoneVerificationPrompt,
  sendAccountPhoneCode,
  verifyAccountPhoneCode,
  deriveCustomerAuthOtpDeliveryCode,
  getCookieConfig,
  getCustomerBySession,
  normalizeCustomerAuthCookieDomain,
  sendOtp,
  updateCustomerProfile,
  verifyOtp,
  type NewAccountDetails,
} from "./customer-auth.service";

const KEY = btoa("0123456789abcdef0123456789abcdef");
const SESSION_KEY = "test-session-key-0123456789abcdef";
const BUYER_EMAIL = "buyer5@example.test";
const BUYER_PHONE = "+8801712000005";
const STRANGER_PHONE = "+8801712000006";

let sqlite: DatabaseSync;
let db: Database;
let ipCounter = 0;

beforeEach(() => {
  sqlite = createMigratedSqlite();
  sqlite.exec(`
    INSERT INTO settings (id, key, value, type, category)
      VALUES ('email', 'document', '{"provider":"cloudflare","sender":"shop@example.test","resendApiKey":""}', 'json', 'email');
    INSERT INTO settings (id, key, value, type, category)
      VALUES ('auth', 'document', '{"email":"optional","whatsapp":"off","channels":["email","sms"]}', 'json', 'customer_auth');
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_1', 'Tee', 'tee', 50000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
      VALUES ('var_1', 'prod_1', 'TEE-1', 50000, 50, 1, 1);
  `);
  db = createSqliteD1Database({ sqlite }).db;
});

afterEach(() => sqlite.close());

const emailEnv = { EMAIL: { send: vi.fn(async () => ({ messageId: "m" })) } };

/** Sends a real code and returns it the way the queue consumer derives it. */
async function sendEmailCode(email: string, ip = `203.0.113.${++ipCounter}`): Promise<string> {
  const sent = await sendOtp(db, {
    method: "email",
    identifier: email,
    ip,
    emailEnv,
    encryptionKey: KEY,
    credentialEncryptionKey: KEY,
  });
  expect(sent.queuePayload).not.toHaveProperty("code");
  return deriveCustomerAuthOtpDeliveryCode({ otpKey: sent.otpStorageKey, deliveryKey: sent.deliveryKey, encryptionKey: KEY });
}

/** An SMS code as the phone channel would deliver it (no SMS provider in tests). */
async function issuePhoneCode(phone: string): Promise<string> {
  const otpKey = await buildCustomerAuthOtpStorageKey("sms", phone, KEY);
  const deliveryKey = `dk_${Math.random().toString(36).slice(2)}`;
  const code = await deriveCustomerAuthOtpDeliveryCode({ otpKey, deliveryKey, encryptionKey: KEY });
  await persistCustomerAuthOtpChallenge(db, {
    otpKey, deliveryKey, method: "phone", channel: "sms", identifier: phone, deliveryTarget: phone,
    code, encryptionKey: KEY, contactEncryptionKey: KEY, ttlSeconds: 300, resendCooldownSeconds: 60, maxAttempts: 5,
  });
  return code;
}

const verifyEmail = (email: string, code: string, account?: NewAccountDetails) =>
  verifyOtp(db, { method: "email", identifier: email, code, account, encryptionKey: KEY, sessionHashKey: SESSION_KEY });
const verifyPhone = (phone: string, code: string, account?: NewAccountDetails) =>
  verifyOtp(db, { method: "phone", identifier: phone, code, account, encryptionKey: KEY, sessionHashKey: SESSION_KEY });

async function createEmailAccount(email: string, phone: string, name = "Buyer Five") {
  const code = await sendEmailCode(email);
  await expect(verifyEmail(email, code)).resolves.toMatchObject({ status: "needs_account_details" });
  const created = await verifyEmail(email, code, { name, phone });
  if (created.status !== "signed_in") throw new Error("account was not created");
  return created;
}

let orderCounter = 0;
/** A guest COD order through the real storefront commit path. */
async function placeGuestOrder(contact: { phone: string; email: string | null; name?: string }) {
  const attempt = createAtomicCheckoutAttempt({
    checkoutRequestId: `request-${++orderCounter}`,
    requestKey: `checkout_submit:v1:${String(orderCounter).padEnd(64, "0")}`,
    requestHash: "b".repeat(64),
    statusToken: `cst_${String(orderCounter).padEnd(64, "0")}`,
  });
  const revision = Number(sqlite.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get()?.revision);
  const payload = {
    checkoutToken: attempt.checkoutToken,
    checkoutAuthorityRevision: revision,
    checkoutSideEffects: { orderCreatedNotification: false, metaPurchase: false },
    existingCustomer: null,
    orderData: {
      id: attempt.orderId,
      customerName: contact.name ?? "Stranger",
      customerPhone: contact.phone,
      customerEmail: contact.email,
      shippingAddress: "House 9, Road 9, Mirpur",
      city: "city_1", zone: "zone_1", area: null, cityName: "Dhaka", zoneName: "Mirpur", areaName: null,
      notes: null,
      totalAmount: 500, shippingCharge: 0, discountAmount: 0,
      currencyCode: "BDT", currencyDecimalPlaces: 2,
      subtotalAmountMinor: 50_000, shippingAmountMinor: 0,
      shippingMethodId: null, shippingMethodName: null, shippingMethodDescription: null,
      shippingMethodBaseAmountMinor: null, shippingFeeWaived: null,
      discountAmountMinor: 0, taxAmountMinor: 0, totalAmountMinor: 50_000,
      taxLabel: "Tax", pricesIncludeTax: false,
      status: "pending", paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 500,
      fulfillmentStatus: "pending", inventoryPool: "regular", inventoryAction: "reserved",
    },
    items: [{
      id: `item_${attempt.orderId}`, taxAllocationLineId: "line_1", cartKey: null, productId: "prod_1",
      variantId: "var_1", quantity: 1, price: 500, productName: "Tee", variantLabel: null,
      productImageMediaId: null, inventoryTracked: true, unitPriceMinor: 50_000, lineSubtotalMinor: 50_000,
      discountAmountMinor: 0, taxableAmountMinor: 0, taxAmountMinor: 0,
    }],
    requestUrl: "https://shop.example.com/api/v1/orders",
    taxQuote: {
      schemaVersion: 1, calculationVersion: "tax-v1", enabled: false, currencyCode: "BDT",
      decimalPlaces: 2, displayLabel: "Tax", pricesIncludeTax: false, shippingTaxed: false,
      settingsVersion: 0, subtotalMinor: 50_000, shippingMinor: 0, discountMinor: 0,
      taxableMinor: 0, taxMinor: 0, totalMinor: 50_000,
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [{
        lineId: "line_1", productId: "prod_1", variantId: "var_1", taxClassId: null, taxClassName: null,
        unitPriceMinor: 50_000, quantity: 1, grossAmountMinor: 50_000, discountMinor: 0,
        taxableAmountMinor: 0, taxMinor: 0, totalMinor: 50_000, components: [],
      }],
      shipping: {
        taxClassId: null, taxClassName: null, grossAmountMinor: 0, discountMinor: 0,
        taxableAmountMinor: 0, taxMinor: 0, totalMinor: 0, components: [],
      },
    },
  } as unknown as StorefrontOrderCommitPayload;
  await commitStorefrontOrderPayload(db, payload, {
    attempt,
    response: { orderId: attempt.orderId, receiptToken: attempt.checkoutToken },
  });
  return attempt.orderId;
}

const customerRows = () => sqlite.prepare(
  "SELECT id, name, email, phone, address, account_claimed_at IS NOT NULL AS claimed, email_verified_at IS NOT NULL AS email_verified, phone_verified_at IS NOT NULL AS phone_verified FROM customers ORDER BY account_claimed_at IS NULL, phone",
).all();
const orderOwner = (orderId: string) =>
  sqlite.prepare("SELECT account_owner_customer_id AS owner FROM orders WHERE id = ?").get(orderId)?.owner ?? null;

const orderLinks = (orderId: string) =>
  sqlite.prepare("SELECT customer_id AS customerId, account_owner_customer_id AS owner FROM orders WHERE id = ?").get(orderId);
const customerById = (id: string) =>
  sqlite.prepare("SELECT id, name, email, phone, address, zone_name AS zoneName, account_claimed_at IS NOT NULL AS claimed FROM customers WHERE id = ?").get(id);

describe("unverified contacts never change identity (R2-BA-01, R2-MKT-02, R2-BA-04)", () => {
  const VICTIM_PHONE = "+8801799200009";

  it("a stranger typing someone's phone at sign-up takes over nothing and locks nobody out", async () => {
    // 1. The victim orders as a guest with their phone only.
    const firstOrder = await placeGuestOrder({ phone: VICTIM_PHONE, email: null, name: "Victim V" });
    const victimRecord = orderLinks(firstOrder)!.customerId as string;

    // 2. A stranger signs up with their own email and types the victim's phone.
    const stranger = await createEmailAccount("stranger@example.test", VICTIM_PHONE, "Stranger S1");
    expect(stranger.customer.customerId).not.toBe(victimRecord);
    expect(customerById(victimRecord)).toMatchObject({ name: "Victim V", email: null, claimed: 0, address: "House 9, Road 9, Mirpur" });
    expect(orderLinks(firstOrder)).toEqual({ customerId: victimRecord, owner: null });

    // 3. The victim can still create their own account with their real phone.
    const victim = await createEmailAccount("victim@example.test", VICTIM_PHONE, "Victim V");
    expect(victim.customer.customerId).not.toBe(stranger.customer.customerId);

    // 4. Another guest order with that phone stays with the guest record, in nobody's account.
    const secondOrder = await placeGuestOrder({ phone: VICTIM_PHONE, email: null, name: "Victim V" });
    expect(orderLinks(secondOrder)).toEqual({ customerId: victimRecord, owner: null });
    expect(customerById(stranger.customer.customerId!)).toMatchObject({ name: "Stranger S1", email: "stranger@example.test" });
    const strangerHistory = await getCustomerOrders(db, stranger.customer.customerId!, {});
    expect(strangerHistory.orders).toEqual([]);

    // 5. Proving the phone by code gives the owner an account with the phone's orders.
    const code = await issuePhoneCode(VICTIM_PHONE);
    const proven = await verifyPhone(VICTIM_PHONE, code, { name: "Victim V", email: "victim.phone@example.test" });
    if (proven.status !== "signed_in") throw new Error("not signed in");
    const ownerId = proven.customer.customerId!;
    expect(orderLinks(firstOrder)).toEqual({ customerId: ownerId, owner: ownerId });
    expect(orderLinks(secondOrder)).toEqual({ customerId: ownerId, owner: ownerId });
  });

  it("a guest checkout never renames, re-emails or re-addresses an existing customer", async () => {
    const firstOrder = await placeGuestOrder({ phone: VICTIM_PHONE, email: null, name: "W4F Orders Test" });
    const record = orderLinks(firstOrder)!.customerId as string;
    const historyBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM customer_history WHERE customer_id = ?").get(record)?.n);

    sqlite.prepare("UPDATE customers SET address = 'House 9, Road 4', zone_name = 'Mirpur' WHERE id = ?").run(record);
    const attack = await placeGuestOrder({ phone: VICTIM_PHONE, email: "r2mkt-buyer@example.com", name: "R2-MKT ক্রেতা Buyer" });

    expect(customerById(record)).toMatchObject({
      name: "W4F Orders Test", email: null, address: "House 9, Road 4", zoneName: "Mirpur", claimed: 0,
    });
    expect(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM customer_history WHERE customer_id = ?").get(record)?.n))
      .toBe(historyBefore);
    // The order keeps its own contact snapshot and is filed with the phone's record.
    expect(orderLinks(attack)).toEqual({ customerId: record, owner: null });
    expect(sqlite.prepare("SELECT customer_name AS name, customer_email AS email FROM orders WHERE id = ?").get(attack))
      .toEqual({ name: "R2-MKT ক্রেতা Buyer", email: "r2mkt-buyer@example.com" });
  });

  it("files every order the same way for the merchant and the buyer (R2-BA-04)", async () => {
    const account = await createEmailAccount(BUYER_EMAIL, BUYER_PHONE);
    const accountId = account.customer.customerId!;

    // A guest order with the account's VERIFIED email joins the account on both sides at once.
    const byEmail = await placeGuestOrder({ phone: STRANGER_PHONE, email: BUYER_EMAIL, name: "Stranger One" });
    expect(orderLinks(byEmail)).toEqual({ customerId: accountId, owner: accountId });

    // A phone-only guest order with the account's UNVERIFIED phone joins neither.
    const byPhone = await placeGuestOrder({ phone: BUYER_PHONE, email: null, name: "Someone" });
    const phoneLinks = orderLinks(byPhone)!;
    expect(phoneLinks.owner).toBeNull();
    expect(phoneLinks.customerId).not.toBe(accountId);

    const history = await getCustomerOrders(db, accountId, {});
    expect(history.orders.map((order) => order.id)).toEqual([byEmail]);
    const merchantView = sqlite.prepare("SELECT id FROM orders WHERE customer_id = ? ORDER BY id").all(accountId)
      .map((row) => row.id);
    expect(merchantView).toEqual([byEmail]);
  });

  it("moves a guest record's orders into the account only for the email just proven, retiring an emptied record", async () => {
    const guestOrder = await placeGuestOrder({ phone: STRANGER_PHONE, email: BUYER_EMAIL, name: "Buyer Five" });
    const guestRecord = orderLinks(guestOrder)!.customerId as string;
    const otherOrder = await placeGuestOrder({ phone: "+8801712000077", email: "someone@example.test", name: "Other" });

    const account = await createEmailAccount(BUYER_EMAIL, BUYER_PHONE);
    const accountId = account.customer.customerId!;
    expect(orderLinks(guestOrder)).toEqual({ customerId: accountId, owner: accountId });
    expect(orderLinks(otherOrder)!.owner).toBeNull();
    // The guest record that only held this buyer's order is merged away; one customer per verified identity.
    expect(sqlite.prepare("SELECT deleted_at IS NOT NULL AS retired FROM customers WHERE id = ?").get(guestRecord))
      .toEqual({ retired: 1 });
  });
});

describe("a shared phone never exposes or files one person's orders under another (R4)", () => {
  const SHARED_PHONE = "+8801799300002";
  const OWN_PHONE = "+8801799300004";
  const OWNER_PHONE = "+8801799300011";
  const OWNER_EMAIL = "r3.owner@example.test";
  const movesOf = (customerId: string) => sqlite.prepare(
    "SELECT change_type AS type, order_id AS orderId, related_customer_id AS relatedId, verified_contact AS via FROM customer_history WHERE customer_id = ? AND change_type NOT IN ('created', 'updated', 'deleted') ORDER BY change_type, order_id",
  ).all(customerId);
  const record = (id: string) => sqlite.prepare(
    "SELECT merged_into_customer_id AS mergedInto, deleted_at IS NOT NULL AS retired, origin, phone_verified_at IS NOT NULL AS phoneVerified FROM customers WHERE id = ?",
  ).get(id);
  const enableSms = () => saveSmsSettings(db, { activeProvider: "bdbulksms", bdbulksmsToken: "merchant-token-4821" }, KEY);
  const sendPhoneCode = async (accountId: string) => {
    const sent = await sendAccountPhoneCode(db, {
      accountId, ip: `203.0.113.${++ipCounter}`, encryptionKey: KEY, credentialEncryptionKey: KEY,
    });
    return { sent, code: await deriveCustomerAuthOtpDeliveryCode({ otpKey: sent.otpStorageKey, deliveryKey: sent.deliveryKey, encryptionKey: KEY }) };
  };

  it("tells a buyer nothing about a stranger's order on the phone they share (R3-SB-01)", async () => {
    // Guest A orders with the shared phone; B orders with the same phone and their own email.
    const strangersOrder = await placeGuestOrder({ phone: SHARED_PHONE, email: null, name: "R3-SB Guest Two" });
    const ownOrder = await placeGuestOrder({ phone: SHARED_PHONE, email: "r3-sb+b4@example.test", name: "R3-SB Other Person" });
    const guestRecord = orderLinks(strangersOrder)!.customerId as string;
    expect(orderLinks(ownOrder)!.customerId).toBe(guestRecord);

    // B signs up with the email and says their phone is another one.
    const b = await createEmailAccount("r3-sb+b4@example.test", OWN_PHONE, "R3-SB Other Person");
    const bId = b.customer.customerId!;
    expect((await getCustomerOrders(db, bId, {})).orders.map((order) => order.id)).toEqual([ownOrder]);

    // No code channel: no prompt at all. With one: only B's OWN phone, never the shared one.
    expect(await getAccountPhoneVerificationPrompt(db, bId, KEY)).toBeNull();
    await enableSms();
    expect(await getAccountPhoneVerificationPrompt(db, bId, KEY)).toEqual({ phone: OWN_PHONE });

    // The stranger's order stays on the phone's guest record, which no account claims.
    expect(orderLinks(strangersOrder)).toEqual({ customerId: guestRecord, owner: null });
    expect(record(guestRecord)).toMatchObject({ mergedInto: null, retired: 0, origin: "order" });
    const { customers: listed } = await listCustomers(db, { limit: 50 });
    expect(listed.find((row) => row.id === guestRecord)).toMatchObject({ kind: "guest", latestOrderName: "R3-SB Guest Two" });
    expect(listed.find((row) => row.id === bId)).toMatchObject({ kind: "account", name: "R3-SB Other Person" });

    // Proving B's own phone adds nothing of the stranger's.
    const { code } = await sendPhoneCode(bId);
    await expect(verifyAccountPhoneCode(db, { accountId: bId, code, encryptionKey: KEY, credentialEncryptionKey: KEY }))
      .resolves.toEqual({ movedOrders: 0 });
    expect(orderLinks(strangersOrder)).toEqual({ customerId: guestRecord, owner: null });
    expect(await getAccountPhoneVerificationPrompt(db, bId, KEY)).toBeNull();
  });

  it("logs sign-up and every linked order with the verified contact, on both records (R3-ORD-12)", async () => {
    const withEmail = await placeGuestOrder({ phone: OWNER_PHONE, email: OWNER_EMAIL, name: "R3 Victim Owner" });
    const phoneOnly = await placeGuestOrder({ phone: OWNER_PHONE, email: null, name: "R3 Victim Owner" });
    const guestId = orderLinks(withEmail)!.customerId as string;
    const ownerId = (await createEmailAccount(OWNER_EMAIL, OWNER_PHONE, "R3 Victim Owner")).customer.customerId!;

    expect(orderLinks(withEmail)).toEqual({ customerId: ownerId, owner: ownerId });
    expect(orderLinks(phoneOnly)).toEqual({ customerId: guestId, owner: null });
    expect(movesOf(ownerId)).toEqual([
      { type: "order_moved_in", orderId: withEmail, relatedId: guestId, via: "email" },
      { type: "signed_up", orderId: null, relatedId: null, via: "email" },
    ]);
    expect(movesOf(guestId)).toEqual([{ type: "order_moved_out", orderId: withEmail, relatedId: ownerId, via: "email" }]);

    // A later signed-out order with the verified email is filed straight to the account, and logged.
    const later = await placeGuestOrder({ phone: "+8801799300099", email: OWNER_EMAIL, name: "Someone Else" });
    expect(orderLinks(later)).toEqual({ customerId: ownerId, owner: ownerId });
    expect(movesOf(ownerId)).toContainEqual({ type: "order_linked", orderId: later, relatedId: null, via: "email" });

    // Proving the account's own phone brings the rest and merges the emptied guest record.
    await enableSms();
    expect(await getAccountPhoneVerificationPrompt(db, ownerId, KEY)).toEqual({ phone: OWNER_PHONE });
    const { sent, code } = await sendPhoneCode(ownerId);
    expect(sent.message).toBe("We sent a code to 01799-300011.");
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(verifyAccountPhoneCode(db, { accountId: ownerId, code: wrong, encryptionKey: KEY, credentialEncryptionKey: KEY }))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(verifyAccountPhoneCode(db, { accountId: ownerId, code, encryptionKey: KEY, credentialEncryptionKey: KEY }))
      .resolves.toEqual({ movedOrders: 1 });
    expect(orderLinks(phoneOnly)).toEqual({ customerId: ownerId, owner: ownerId });
    expect(record(ownerId)).toMatchObject({ phoneVerified: 1 });
    expect(record(guestId)).toMatchObject({ mergedInto: ownerId, retired: 1 });
    expect(movesOf(guestId)).toContainEqual({ type: "order_moved_out", orderId: phoneOnly, relatedId: ownerId, via: "phone" });

    // Merged, not trashed: neither the list, the trash nor search shows it.
    const active = await listCustomers(db, { limit: 50 });
    const trash = await listCustomers(db, { limit: 50, showTrashed: true });
    expect(active.customers.map((row) => row.id)).not.toContain(guestId);
    expect(trash.customers).toEqual([]);
  });

  it("refuses to prove a phone that another account already proved", async () => {
    await enableSms();
    const account = await createEmailAccount(BUYER_EMAIL, OWNER_PHONE);
    sqlite.prepare(
      "INSERT INTO customers (id, name, phone, origin, account_claimed_at, phone_verified_at) VALUES ('cust_phone_owner', 'Phone Owner', ?, 'account', unixepoch(), unixepoch())",
    ).run(OWNER_PHONE);
    const { code } = await sendPhoneCode(account.customer.customerId!);
    await expect(verifyAccountPhoneCode(db, { accountId: account.customer.customerId!, code, encryptionKey: KEY, credentialEncryptionKey: KEY }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("titles checkout guest records by phone, and keeps a merchant's customer by name", async () => {
    const order = await placeGuestOrder({ phone: SHARED_PHONE, email: null, name: "First Buyer" });
    const guestId = orderLinks(order)!.customerId as string;
    await placeGuestOrder({ phone: SHARED_PHONE, email: null, name: "Second Buyer" });
    const merchant = await createCustomer(db, { name: "R3-ORD Owner রিনা", phone: OWN_PHONE, email: null, address: null, city: null, zone: null, area: null });
    const impostor = await placeGuestOrder({ phone: OWN_PHONE, email: null, name: "R3-ORD Impostor" });

    const { customers: listed } = await listCustomers(db, { limit: 50 });
    expect(listed.find((row) => row.id === guestId)).toMatchObject({ kind: "guest", latestOrderName: "Second Buyer" });
    expect(listed.find((row) => row.id === merchant.id)).toMatchObject({ kind: "merchant", name: "R3-ORD Owner রিনা" });
    // The order keeps its own name; the merchant sees which record it is filed under.
    const detail = await getOrderDetails(db, impostor);
    expect(detail).toMatchObject({
      customerName: "R3-ORD Impostor",
      customerRecord: { id: merchant.id, name: "R3-ORD Owner রিনা", kind: "merchant" },
    });
    // Naming a guest record in the dashboard makes it the merchant's customer.
    await updateCustomer(db, guestId, { name: "Named By Merchant" });
    expect(await getCustomerDetail(db, guestId)).toMatchObject({ kind: "merchant", name: "Named By Merchant" });
  });
});

describe("merchant changes are attributed and reversible (R3-ORD-13, R3-ORD-17)", () => {
  const log = (customerId: string) => sqlite.prepare(
    "SELECT change_type AS type, actor, actor_id AS actorId FROM customer_history WHERE customer_id = ? ORDER BY rowid",
  ).all(customerId);

  it("records the staff author, logs a restore from trash, and names the customer already using a phone", async () => {
    const created = await createCustomer(db, { name: "Rina", phone: BUYER_PHONE, email: null, address: null, city: null, zone: null, area: null }, "staff_1");
    await expect(createCustomer(db, { name: "Other", phone: BUYER_PHONE, email: null, address: null, city: null, zone: null, area: null }, "staff_1"))
      .rejects.toMatchObject({ details: { customer: { id: created.id, name: "Rina", kind: "merchant" } } });

    await updateCustomer(db, created.id, { name: "Rina Akter" }, "staff_2");
    await deleteCustomer(db, created.id, "staff_2");
    await restoreCustomer(db, created.id, "staff_1");
    expect(await getCustomerDetail(db, created.id)).toMatchObject({ deletedAt: null, name: "Rina Akter" });
    expect(log(created.id)).toEqual([
      { type: "created", actor: "staff", actorId: "staff_1" },
      { type: "updated", actor: "staff", actorId: "staff_2" },
      { type: "deleted", actor: "staff", actorId: "staff_2" },
      { type: "restored", actor: "staff", actorId: "staff_1" },
    ]);

    // A checkout guest record is made by the buyer; a merged one can't be restored.
    const order = await placeGuestOrder({ phone: STRANGER_PHONE, email: "merge.me@example.test", name: "Merge Me" });
    const guestId = orderLinks(order)!.customerId as string;
    expect(log(guestId)).toEqual([{ type: "created", actor: "buyer", actorId: null }]);
    await createEmailAccount("merge.me@example.test", STRANGER_PHONE, "Merge Me");
    await expect(restoreCustomer(db, guestId, "staff_1")).rejects.toThrow("merged into an account");
  });
});

describe("phone sign-in (R3-SB-07)", () => {
  it("is offered only when the store chose a phone channel in Customer accounts", async () => {
    const emailOnly = { email: "required", whatsapp: "off", channels: ["email"] } as const;
    await saveSmsSettings(db, { activeProvider: "bdbulksms", bdbulksmsToken: "merchant-token-4821" }, KEY);
    // SMS can send, but the merchant didn't choose it: it is never added.
    expect((await getOfferedCustomerIdentity(db, { ...emailOnly, channels: [...emailOnly.channels] }, { encryptionKey: KEY })).channels)
      .not.toContain("sms");
    await customerAuthDocument.write(db, { ...emailOnly, channels: ["email"] });
    await expect(sendOtp(db, { method: "phone", identifier: BUYER_PHONE, ip: "203.0.113.200", encryptionKey: KEY, credentialEncryptionKey: KEY }))
      .rejects.toThrow("Phone sign-in isn't available yet. Use your email.");

    await customerAuthDocument.write(db, { email: "optional", whatsapp: "off", channels: ["sms"] });
    await expect(sendOtp(db, { method: "phone", identifier: BUYER_PHONE, ip: "203.0.113.201", encryptionKey: KEY, credentialEncryptionKey: KEY }))
      .resolves.toMatchObject({ message: "We sent you a code." });
  });

  it("fails closed when the chosen channel can't send, without falling back", async () => {
    await customerAuthDocument.write(db, { email: "required", whatsapp: "same_as_phone", channels: ["whatsapp", "sms"] });
    await saveSmsSettings(db, { activeProvider: "bdbulksms", bdbulksmsToken: "merchant-token-4821" }, KEY);
    await expect(sendOtp(db, { method: "phone", identifier: BUYER_PHONE, channel: "whatsapp", ip: "203.0.113.202", encryptionKey: KEY, credentialEncryptionKey: KEY }))
      .rejects.toThrow("WhatsApp codes aren't available right now.");
  });

  it("gives a phone-proven buyer their own account and moves the phone's orders there, never renaming the guest record", async () => {
    const guestOrder = await placeGuestOrder({ phone: BUYER_PHONE, email: null, name: "Guest Name" });
    const guestId = orderLinks(guestOrder)!.customerId as string;
    const code = await issuePhoneCode(BUYER_PHONE);
    await expect(verifyPhone(BUYER_PHONE, code)).resolves.toMatchObject({ status: "needs_account_details" });
    const signedIn = await verifyPhone(BUYER_PHONE, code, { name: "Real Owner", email: "real.owner@example.test" });
    if (signedIn.status !== "signed_in") throw new Error("not signed in");
    const accountId = signedIn.customer.customerId!;
    expect(accountId).not.toBe(guestId);
    expect(signedIn.customer).toMatchObject({ name: "Real Owner", phone: BUYER_PHONE });
    expect(orderLinks(guestOrder)).toEqual({ customerId: accountId, owner: accountId });
    expect(sqlite.prepare("SELECT merged_into_customer_id AS mergedInto, deleted_at IS NOT NULL AS retired FROM customers WHERE id = ?").get(guestId)).toEqual({ mergedInto: accountId, retired: 1 });
  });
});

describe("guest checkout contacts never lock a buyer out (BA-01)", () => {
  it("signs the verified owner in after a stranger's guest order used their email", async () => {
    // 1. The buyer creates an account with their email and phone, then signs out.
    const account = await createEmailAccount(BUYER_EMAIL, BUYER_PHONE);
    await deleteCustomerSession(db, account.session.token, SESSION_KEY);

    // 2. A stranger places a guest order with the buyer's email and their own phone.
    const strangerOrder = await placeGuestOrder({ phone: STRANGER_PHONE, email: BUYER_EMAIL });

    // 3. The buyer signs in: the code is sent and the verified owner signs in.
    const code = await sendEmailCode(BUYER_EMAIL);
    const signedIn = await verifyEmail(BUYER_EMAIL, code);

    expect(signedIn).toMatchObject({ status: "signed_in", isNewUser: false });
    if (signedIn.status !== "signed_in") return;
    expect(signedIn.customer).toMatchObject({
      customerId: account.customer.customerId,
      email: BUYER_EMAIL,
      phone: BUYER_PHONE,
      name: "Buyer Five",
    });
    // The account's identity is unchanged by the stranger's contact details.
    expect(customerRows()).toEqual([
      expect.objectContaining({ id: account.customer.customerId, email: BUYER_EMAIL, phone: BUYER_PHONE, claimed: 1, email_verified: 1 }),
    ]);
    // An order placed with the verified email is filed under its owner (Shopify semantics).
    expect(orderLinks(strangerOrder)).toEqual({ customerId: account.customer.customerId, owner: account.customer.customerId });
  });

  it("does not let an unverified email saved on another account take the inbox owner's sign-in", async () => {
    // Someone signs up by phone and types the buyer's email (never verified).
    const phoneCode = await issuePhoneCode(STRANGER_PHONE);
    const other = await verifyPhone(STRANGER_PHONE, phoneCode, { name: "Other", email: BUYER_EMAIL });
    expect(other).toMatchObject({ status: "signed_in", isNewUser: true });

    // The inbox owner proves the email: they are a new buyer, not "the other account".
    const code = await sendEmailCode(BUYER_EMAIL);
    await expect(verifyEmail(BUYER_EMAIL, code)).resolves.toEqual({ status: "needs_account_details", suggestion: null });
    const own = await verifyEmail(BUYER_EMAIL, code, { name: "Buyer Five", phone: BUYER_PHONE });
    expect(own.status).toBe("signed_in");
    if (own.status !== "signed_in" || other.status !== "signed_in") return;
    expect(own.customer.customerId).not.toBe(other.customer.customerId);

    // Later sign-ins with the email always reach the verified owner.
    const again = await verifyEmail(BUYER_EMAIL, await sendEmailCode(BUYER_EMAIL));
    expect(again).toMatchObject({ status: "signed_in", customer: { customerId: own.customer.customerId } });
  });
});

describe("one sign-in flow", () => {
  it("sends a code for an unknown email without revealing it, then creates the account after the code", async () => {
    const code = await sendEmailCode("new@example.test");
    expect(customerRows()).toEqual([]);

    await expect(verifyEmail("new@example.test", code)).resolves.toEqual({ status: "needs_account_details", suggestion: null });
    // The proven code stays usable for the details step; details are validated.
    await expect(verifyEmail("new@example.test", code, { name: " ", phone: BUYER_PHONE }))
      .rejects.toThrow("Enter your name.");
    await expect(verifyEmail("new@example.test", code, { name: "New Buyer" }))
      .rejects.toThrow("Enter your phone number.");

    const created = await verifyEmail("new@example.test", code, { name: "New Buyer", phone: "০১৭১২ ০০০-০০৫" });
    expect(created).toMatchObject({ status: "signed_in", isNewUser: true, customer: { phone: BUYER_PHONE, profileComplete: false } });
    expect(customerRows()).toEqual([
      expect.objectContaining({ email: "new@example.test", phone: BUYER_PHONE, claimed: 1, email_verified: 1, phone_verified: 0 }),
    ]);
    // A used code cannot be replayed.
    await expect(verifyEmail("new@example.test", code)).rejects.toThrow("That code was already used.");
  });

  it("pre-fills a new buyer from their latest order and saves its address only when asked (R2-SJ-09)", async () => {
    await placeGuestOrder({ phone: STRANGER_PHONE, email: "Rahim@Example.test", name: "Old Name" });
    await placeGuestOrder({ phone: BUYER_PHONE, email: "rahim@example.test", name: "Rahim Uddin" });
    const orderNumber = sqlite.prepare(
      "SELECT order_number AS n FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 1",
    ).get(BUYER_PHONE)?.n;

    const code = await sendEmailCode("rahim@example.test");
    await expect(verifyEmail("rahim@example.test", code)).resolves.toEqual({
      status: "needs_account_details",
      suggestion: {
        name: "Rahim Uddin",
        phone: BUYER_PHONE,
        email: "rahim@example.test",
        address: { orderNumber, text: "House 9, Road 9, Mirpur, Dhaka" },
      },
    });

    const created = await verifyEmail("rahim@example.test", code, { name: "Rahim Uddin", phone: BUYER_PHONE, saveOrderAddress: true });
    if (created.status !== "signed_in") throw new Error("account was not created");
    expect(customerById(created.customer.customerId!)).toMatchObject({ address: "House 9, Road 9, Mirpur", zoneName: "Mirpur" });

    // Without asking, nothing from the order is saved.
    await placeGuestOrder({ phone: STRANGER_PHONE, email: "karim@example.test", name: "Karim" });
    const karimCode = await sendEmailCode("karim@example.test");
    const karim = await verifyEmail("karim@example.test", karimCode, { name: "Karim", phone: STRANGER_PHONE });
    if (karim.status !== "signed_in") throw new Error("account was not created");
    expect(customerById(karim.customer.customerId!)).toMatchObject({ address: null, zoneName: null });
  });

  it("reveals nothing about accounts to someone without the code", async () => {
    await createEmailAccount(BUYER_EMAIL, BUYER_PHONE);
    const code = await sendEmailCode("attacker@example.test");
    const wrong = code === "111111" ? "222222" : "111111";
    // Wrong code with sign-up details for a taken phone: only "wrong code".
    await expect(verifyEmail("attacker@example.test", wrong, { name: "X", phone: BUYER_PHONE }))
      .rejects.toThrow("That code isn't right.");
    expect(customerRows()).toHaveLength(1);
    // A typed phone is only a contact: someone else's number neither blocks nor joins accounts.
    const second = await verifyEmail("attacker@example.test", code, { name: "X", phone: BUYER_PHONE });
    expect(second).toMatchObject({ status: "signed_in", isNewUser: true });
    expect(customerRows()).toHaveLength(2);
  });

  it("adds orders placed while signed out with the verified email, on any device (BA-03)", async () => {
    const account = await createEmailAccount(BUYER_EMAIL, BUYER_PHONE);
    const later = await placeGuestOrder({ phone: "+8801712000099", email: "  Buyer5@Example.test " });
    expect(orderOwner(later)).toBe(account.customer.customerId);

    await linkVerifiedContactOrders(db, account.customer.customerId!);
    const history = await getCustomerOrders(db, account.customer.customerId!, {});
    expect(history.orders.map((order) => order.id)).toContain(later);
  });

  it("asks a closed account to contact the store only after the code is proven", async () => {
    const account = await createEmailAccount(BUYER_EMAIL, BUYER_PHONE);
    sqlite.prepare("UPDATE customers SET deleted_at = unixepoch() WHERE id = ?").run(account.customer.customerId!);
    const code = await sendEmailCode(BUYER_EMAIL);
    const wrong = code === "111111" ? "222222" : "111111";
    await expect(verifyEmail(BUYER_EMAIL, wrong)).rejects.toThrow("That code isn't right.");
    await expect(verifyEmail(BUYER_EMAIL, code)).rejects.toThrow("This account was closed.");
  });
});

describe("codes and limits (BA-02, BA-15)", () => {
  it("counts wrong codes, names a replaced code, and locks after five", async () => {
    const first = await sendEmailCode(BUYER_EMAIL);
    sqlite.prepare("UPDATE customer_auth_otp_challenges SET resend_available_at = 0").run();
    const second = await sendEmailCode(BUYER_EMAIL);
    const wrong = ["000000", "999999", first, second].find((value) => value !== first && value !== second)!;

    if (first !== second) {
      await expect(verifyEmail(BUYER_EMAIL, first)).rejects.toMatchObject({
        message: "That code was replaced by a newer one. Enter the latest code we sent.",
        details: { attemptsLeft: 4 },
      });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(verifyEmail(BUYER_EMAIL, wrong)).rejects.toBeInstanceOf(ValidationError);
    }
    const locked = await verifyEmail(BUYER_EMAIL, wrong).catch((error: unknown) => error);
    expect(locked).toMatchObject({ details: { attemptsLeft: 0 } });
    // Once locked even the right code fails; a new code can be sent right away.
    await expect(verifyEmail(BUYER_EMAIL, second)).rejects.toMatchObject({ details: { attemptsLeft: 0 } });
    await expect(sendEmailCode(BUYER_EMAIL)).resolves.toMatch(/^\d{6}$/);
  });

  it("waits out the resend cooldown with an honest retry time", async () => {
    await sendEmailCode(BUYER_EMAIL);
    const error = await sendEmailCode(BUYER_EMAIL).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBeGreaterThan(50);
    expect((error as RateLimitError).details).toEqual({ retryAfterSeconds: (error as RateLimitError).retryAfterSeconds });
  });

  it("keeps the latest code usable when others flood the email from many networks (R2-BA-06)", async () => {
    let latest = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      latest = await sendEmailCode(BUYER_EMAIL, `198.51.100.${attempt}`);
      sqlite.prepare("UPDATE customer_auth_otp_challenges SET resend_available_at = 0").run();
    }
    const ceiling = await sendEmailCode(BUYER_EMAIL, "198.51.100.200").catch((caught: unknown) => caught);
    expect(ceiling).toBeInstanceOf(RateLimitError);
    expect((ceiling as RateLimitError).message).toBe("Too many codes. Enter the latest code we sent.");
    const expiresAt = Number(sqlite.prepare("SELECT expires_at AS e FROM customer_auth_otp_challenges").get()?.e);
    expect(expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(20 * 60);
    await expect(verifyEmail(BUYER_EMAIL, latest)).resolves.toEqual({ status: "needs_account_details", suggestion: null });
  });

  it("limits codes per email, not per shared carrier IP", async () => {
    const sharedIp = "198.51.100.7";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sendEmailCode(BUYER_EMAIL, sharedIp);
      sqlite.prepare("UPDATE customer_auth_otp_challenges SET resend_available_at = 0").run();
    }
    const limited = await sendEmailCode(BUYER_EMAIL, sharedIp).catch((caught: unknown) => caught);
    expect(limited).toBeInstanceOf(RateLimitError);
    expect((limited as RateLimitError).message).toBe("Too many codes.");
    expect((limited as RateLimitError).retryAfterSeconds).toBeGreaterThan(14 * 60);
    // Other buyers behind the same IP still get codes.
    for (let buyer = 0; buyer < 10; buyer += 1) {
      await expect(sendEmailCode(`other${buyer}@example.test`, sharedIp)).resolves.toMatch(/^\d{6}$/);
    }
  });
});

describe("sessions and profile", () => {
  it("reads, revokes and cleans D1 sessions", async () => {
    const account = await createEmailAccount(BUYER_EMAIL, BUYER_PHONE);
    const session = await getCustomerBySession(db, account.session.token, SESSION_KEY);
    expect(session).toMatchObject({ customerId: account.customer.customerId, email: BUYER_EMAIL, profileComplete: false });
    expect(sqlite.prepare("SELECT token_hash FROM customer_sessions").get()?.token_hash).not.toBe(account.session.token);

    await deleteCustomerSession(db, account.session.token, SESSION_KEY);
    await expect(getCustomerBySession(db, account.session.token, SESSION_KEY)).resolves.toBeNull();
    const cleaned = await cleanupExpiredCustomerSessions(db, Math.floor(Date.now() / 1000) + 8 * 24 * 60 * 60);
    expect(cleaned.deleted).toBe(1);
  });

  it("rejects a blank name and an address-less location instead of saving them (BA-08)", async () => {
    sqlite.exec(`
      INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active) VALUES
        ('city_dhaka', 'Dhaka', 'city', NULL, '{}', '{}', 1),
        ('zone_mirpur', 'Mirpur', 'zone', 'city_dhaka', '{}', '{}', 1);
    `);
    const account = await createEmailAccount(BUYER_EMAIL, BUYER_PHONE);
    await expect(updateCustomerProfile(db, account.session, { name: "" })).rejects.toThrow("Enter your name.");
    await expect(updateCustomerProfile(db, account.session, { city: "city_dhaka", zone: "zone_mirpur" }))
      .rejects.toThrow("Enter your delivery address.");
    const saved = await updateCustomerProfile(db, account.session, {
      address: "House 1", city: "city_dhaka", zone: "zone_mirpur",
    });
    expect(saved.customer).toMatchObject({ name: "Buyer Five", cityName: "Dhaka", zoneName: "Mirpur", profileComplete: true });
  });
});

describe("customer auth cookie domain", () => {
  it("keeps cookies host-only by default and honours only a valid explicit domain", () => {
    expect(getCookieConfig("https://shop.example.co.uk")).toEqual({ sameSite: "None", domainAttr: "" });
    expect(getCookieConfig("https://storefront.scalius.com", ".SCALIUS.com.")).toEqual({
      sameSite: "None",
      domainAttr: "; Domain=.scalius.com",
    });
    for (const invalid of ["localhost", "127.0.0.1", "shop", "https://example.com"]) {
      expect(normalizeCustomerAuthCookieDomain(invalid)).toBe("");
    }
  });
});
