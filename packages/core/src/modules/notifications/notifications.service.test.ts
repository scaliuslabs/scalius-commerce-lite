import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

const mocks = vi.hoisted(() => ({
    getNotificationChannels: vi.fn(),
    getActiveSmsProvider: vi.fn(),
    sendSms: vi.fn(),
}));

vi.mock("../settings/settings.service", () => ({
    getNotificationChannels: mocks.getNotificationChannels,
}));

vi.mock("../../integrations/sms", () => ({
    getActiveSmsProvider: mocks.getActiveSmsProvider,
}));

vi.mock("../../integrations/email", () => ({
    sendEmail: vi.fn(),
}));

import { sendOrderNotificationEmail } from "./notifications.service";
import { ORDER_NOTIFICATION_TYPES } from "./notification-types";

function createDb(customerPhone = "+8801700000000"): Database {
    return {
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    get: vi.fn(async () => ({ customerPhone })),
                })),
            })),
        })),
    } as unknown as Database;
}

describe("order notification dispatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("keeps the shared notification type list complete", () => {
        expect(ORDER_NOTIFICATION_TYPES).toEqual([
            "order_created",
            "order_confirmed",
            "order_processing",
            "order_shipped",
            "order_delivered",
            "order_completed",
            "order_cancelled",
            "order_returned",
            "order_refunded",
        ]);
    });

    it("passes the credential encryption key when resolving SMS providers", async () => {
        const db = createDb();
        mocks.getNotificationChannels.mockResolvedValue({
            order_refunded: ["sms"],
        });
        mocks.sendSms.mockResolvedValue({ success: true, providerRef: "sms_1" });
        mocks.getActiveSmsProvider.mockResolvedValue({
            name: "Test SMS",
            sendSms: mocks.sendSms,
        });

        await sendOrderNotificationEmail(
            undefined,
            "SMS Customer",
            "order_1",
            "order_refunded",
            {},
            db,
            { encryptionKey: "credential-key" },
        );

        expect(mocks.getActiveSmsProvider).toHaveBeenCalledWith(
            db,
            "credential-key",
        );
        expect(mocks.sendSms).toHaveBeenCalledWith({
            to: "+8801700000000",
            message:
                "Hi SMS Customer, your order #order_1 has been refunded. Contact us if you have questions.",
        });
    });
});
