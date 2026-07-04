import { describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { orderNotificationDeliveryReceipts, settings } from "@scalius/database/schema";
import {
    getNotificationProviderBlock,
    isNotificationProviderBreakerFailure,
} from "./notification-provider-health";

type ProviderBlockTestReceipt = {
    providerStatus: string | null;
    rawResponse: string | null;
    lastError: string | null;
    skippedAt: number | Date | null;
    failedAt: number | Date | null;
    updatedAt: number | Date;
};

describe("notification provider health", () => {
    it("blocks merchant-actionable provider setup and credential failures", () => {
        expect(isNotificationProviderBreakerFailure("error=405: Authorization required")).toBe(true);
        expect(isNotificationProviderBreakerFailure("Invalid API key")).toBe(true);
        expect(isNotificationProviderBreakerFailure("HTTP 403 forbidden")).toBe(true);
        expect(isNotificationProviderBreakerFailure("Sender ID is not approved")).toBe(true);
        expect(isNotificationProviderBreakerFailure("invalid_grant service account disabled")).toBe(true);
    });

    it("does not block transient or per-recipient failures provider-wide", () => {
        expect(isNotificationProviderBreakerFailure("temporary gateway timeout")).toBe(false);
        expect(isNotificationProviderBreakerFailure("HTTP 429 too many requests")).toBe(false);
        expect(isNotificationProviderBreakerFailure("invalid number")).toBe(false);
        expect(isNotificationProviderBreakerFailure("Insufficient balance")).toBe(false);
    });

    it("recovers a provider pause from terminal delivery receipts newer than settings", async () => {
        const db = createProviderHealthDb({
            latestSettingsUpdatedAt: 100,
            receipts: [
                {
                    providerStatus: "temporary gateway timeout",
                    rawResponse: null,
                    lastError: null,
                    skippedAt: 150,
                    failedAt: null,
                    updatedAt: 150,
                },
                {
                    providerStatus: "error=405: Authorization required",
                    rawResponse: "error=405: Authorization required",
                    lastError: null,
                    skippedAt: 140,
                    failedAt: null,
                    updatedAt: 140,
                },
            ],
        });

        const block = await getNotificationProviderBlock(db, {
            channel: "sms",
            provider: "smsnetbd",
        });

        expect(block).toMatchObject({
            channel: "sms",
            provider: "smsnetbd",
            reason: "error=405: Authorization required",
            blockedAt: 140,
            source: "receipt",
        });
        expect(db.calls.receiptReads).toBe(1);
    });

    it("recovers WhatsApp provider pauses from receipt evidence", async () => {
        const db = createProviderHealthDb({
            latestSettingsUpdatedAt: 100,
            receipts: [
                {
                    providerStatus: "Invalid token",
                    rawResponse: null,
                    lastError: null,
                    skippedAt: 180,
                    failedAt: null,
                    updatedAt: 180,
                },
            ],
        });

        const block = await getNotificationProviderBlock(db, {
            channel: "whatsapp",
            provider: "whatsapp",
        });

        expect(block).toMatchObject({
            channel: "whatsapp",
            provider: "whatsapp",
            reason: "Invalid token",
            blockedAt: 180,
            source: "receipt",
        });
        expect(db.calls.receiptReads).toBe(1);
    });

    it("does not recover stale receipt failures after settings were saved", async () => {
        const db = createProviderHealthDb({
            latestSettingsUpdatedAt: 200,
            receipts: [
                {
                    providerStatus: "error=405: Authorization required",
                    rawResponse: "error=405: Authorization required",
                    lastError: null,
                    skippedAt: 140,
                    failedAt: null,
                    updatedAt: 140,
                },
            ],
        });

        const block = await getNotificationProviderBlock(db, {
            channel: "sms",
            provider: "smsnetbd",
        });

        expect(block).toBeNull();
    });

    it("returns explicit provider-health markers before scanning receipts", async () => {
        const db = createProviderHealthDb({
            marker: {
                channel: "sms",
                provider: "smsnetbd",
                reason: "Invalid API key",
                blockedAt: 500,
            },
            latestSettingsUpdatedAt: 100,
            receipts: [
                {
                    providerStatus: "error=405: Authorization required",
                    rawResponse: "error=405: Authorization required",
                    lastError: null,
                    skippedAt: 140,
                    failedAt: null,
                    updatedAt: 140,
                },
            ],
        });

        const block = await getNotificationProviderBlock(db, {
            channel: "sms",
            provider: "smsnetbd",
        });

        expect(block).toMatchObject({
            reason: "Invalid API key",
            source: "marker",
        });
        expect(db.calls.receiptReads).toBe(0);
    });
});

function createProviderHealthDb(options: {
    marker?: {
        channel: string;
        provider: string;
        reason: string;
        blockedAt: number;
    };
    latestSettingsUpdatedAt?: number | Date | string;
    receipts?: ProviderBlockTestReceipt[];
}): Database & { calls: { receiptReads: number } } {
    const calls = { receiptReads: 0 };
    const db = {
        calls,
        select() {
            let table: unknown;
            let ordered = false;
            const query = {
                from(nextTable: unknown) {
                    table = nextTable;
                    return query;
                },
                where() {
                    return query;
                },
                orderBy() {
                    ordered = true;
                    return query;
                },
                limit() {
                    return query;
                },
                get() {
                    if (table !== settings) return undefined;
                    if (!ordered) {
                        return options.marker ? { value: JSON.stringify(options.marker) } : undefined;
                    }
                    return options.latestSettingsUpdatedAt === undefined
                        ? undefined
                        : { updatedAt: options.latestSettingsUpdatedAt };
                },
                all() {
                    if (table === orderNotificationDeliveryReceipts) {
                        calls.receiptReads += 1;
                        return options.receipts ?? [];
                    }
                    return [];
                },
            };
            return query;
        },
    };

    return db as unknown as Database & { calls: { receiptReads: number } };
}
