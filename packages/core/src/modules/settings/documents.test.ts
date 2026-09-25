// Wave B settings documents: reviews, gift cards, the checkout delivery
// timing and the channel defaults of the new notification types.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "@scalius/core/errors";

import {
  checkoutDocument,
  DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
  DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
  giftCardsDocument,
  notificationsDocument,
  notificationTemplatesDocument,
  readGiftCardSettings,
  readReviewSettings,
  reviewsDocument,
} from "./documents";

describe("Wave B settings documents", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });

  afterEach(() => sqlite.close());

  const store = (category: string, value: string) => sqlite
    .prepare("INSERT INTO settings (id, key, value, type, category, revision) VALUES (?, 'document', ?, 'json', ?, 1)")
    .run(`set_${category}`, value, category);

  it("turns reviews on by default, with auto moderation and a request 7 days after delivery", async () => {
    expect(await readReviewSettings(db)).toEqual({
      ok: true,
      revision: 0,
      value: { enabled: true, moderation: "auto", requestsEnabled: true, requestDelayDays: 7, blockWords: [] },
    });
    await reviewsDocument.write(db, { enabled: false, moderation: "hold", blockWords: ["spam", "ফালতু"] });
    expect(await readReviewSettings(db)).toMatchObject({
      ok: true,
      value: { enabled: false, moderation: "hold", requestDelayDays: 7, blockWords: ["spam", "ফালতু"] },
    });
  });

  it("refuses review settings outside the documented bounds", async () => {
    for (const patch of [
      { requestDelayDays: 0 },
      { requestDelayDays: 61 },
      { requestDelayDays: 1.5 },
      { moderation: "by_rating" },
      { blockWords: Array.from({ length: 51 }, (_, index) => `w${index}`) },
      { blockWords: [" "] },
      { blockWords: ["x".repeat(41)] },
    ]) {
      await expect(reviewsDocument.write(db, patch as never)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("fails closed when the reviews document is unreadable or invalid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store("reviews", '{"enabled":true,"requestDelayDays":999}');
    expect(await readReviewSettings(db)).toEqual({ ok: false, reason: "invalid" });

    const broken = { select: () => { throw new Error("D1 unavailable"); } } as unknown as Database;
    expect(await readReviewSettings(broken)).toEqual({ ok: false, reason: "unreadable" });
    expect(await readGiftCardSettings(broken)).toEqual({ ok: false, reason: "unreadable" });
    vi.restoreAllMocks();
  });

  it("never expires gift cards by default and bounds the default expiry", async () => {
    expect(await readGiftCardSettings(db)).toEqual({ ok: true, revision: 0, value: { defaultExpiryMonths: null } });
    await giftCardsDocument.write(db, { defaultExpiryMonths: 12 });
    expect(await readGiftCardSettings(db)).toMatchObject({ ok: true, value: { defaultExpiryMonths: 12 } });
    for (const months of [0, 121, 2.5]) {
      await expect(giftCardsDocument.write(db, { defaultExpiryMonths: months })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("hands digital and gift-card lines over after payment unless the store waits for confirmation", async () => {
    expect((await checkoutDocument.read(db)).autoFulfilMode).toBe("after_payment");
    // A document saved before the setting existed keeps its fields and gets the default.
    store("checkout", '{"checkoutMode":"gateways_only"}');
    expect(await checkoutDocument.read(db)).toMatchObject({ checkoutMode: "gateways_only", autoFulfilMode: "after_payment" });
    await checkoutDocument.write(db, { autoFulfilMode: "after_confirmation" });
    expect(await checkoutDocument.read(db)).toMatchObject({ checkoutMode: "gateways_only", autoFulfilMode: "after_confirmation" });
    await expect(checkoutDocument.write(db, { autoFulfilMode: "never" as never })).rejects.toBeInstanceOf(ValidationError);
  });

  it("defaults the new notification channels as the design lists them", async () => {
    expect(DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS).toMatchObject({
      order_digital_delivered: ["email", "sms"],
      gift_card_issued: ["email", "sms"],
      review_request: ["email"],
      review_pending: [],
      digital_keys_exhausted: [],
    });
    expect(DEFAULT_ADMIN_NOTIFICATION_CHANNELS).toMatchObject({
      order_digital_delivered: [],
      gift_card_issued: [],
      review_request: [],
      review_pending: ["push"],
      digital_keys_exhausted: ["push", "email"],
    });

    // Codes and keys are not in the order WhatsApp template; staff alerts never reach buyers.
    await notificationsDocument.write(db, {
      orderChannels: { gift_card_issued: ["email", "whatsapp"], review_pending: ["email"] },
      adminChannels: { review_request: ["push"], digital_keys_exhausted: ["email"] },
    });
    const saved = await notificationsDocument.read(db);
    expect(saved.orderChannels).toMatchObject({ gift_card_issued: ["email"], review_pending: [], order_created: ["email"] });
    expect(saved.adminChannels).toMatchObject({ review_request: [], digital_keys_exhausted: ["email"] });
  });

  it("stores merchant copy for the new buyer messages like the order ones", async () => {
    await notificationTemplatesDocument.write(db, {
      email: { gift_card_issued: { subject: "A gift from {{store_name}}", body: "Code: {{gift_card_code}}" } },
      sms: { review_request: { body: "Review {{order_number}}: {{review_link}}" } },
    });
    expect(await notificationTemplatesDocument.read(db)).toEqual({
      email: { gift_card_issued: { subject: "A gift from {{store_name}}", body: "Code: {{gift_card_code}}" } },
      sms: { review_request: { body: "Review {{order_number}}: {{review_link}}" } },
    });
  });
});
