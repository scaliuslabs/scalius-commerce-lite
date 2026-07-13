import { describe, expect, it } from "vitest";

import {
    createAccountSessionCommandIdFactory,
    describeAccountSessionDevice,
    maskAccountSessionIp,
    presentAccountSession,
} from "./account-session-presentation";

const TEST_COMMAND_SECRET = "test-account-session-command-secret";

describe("account session presentation", () => {
    it("derives a useful device label without returning the raw user agent", () => {
        const rawUserAgent =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36";

        expect(describeAccountSessionDevice(rawUserAgent)).toEqual({
            label: "Chrome on macOS",
            type: "desktop",
        });
        expect(JSON.stringify(describeAccountSessionDevice(rawUserAgent))).not.toContain(
            "Mozilla",
        );
    });

    it("recognizes mobile and tablet sessions", () => {
        expect(
            describeAccountSessionDevice(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1",
            ),
        ).toEqual({ label: "Safari on iPhone", type: "mobile" });
        expect(
            describeAccountSessionDevice(
                "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
            ),
        ).toEqual({ label: "Chrome on Android tablet", type: "tablet" });
    });

    it("masks recognized network addresses and drops malformed values", () => {
        expect(maskAccountSessionIp("203.0.113.42")).toBe("203.0.113.x");
        expect(maskAccountSessionIp("2001:db8:abcd:0012::1")).toBe(
            "2001:db8:abcd:…",
        );
        expect(maskAccountSessionIp("not-an-ip-address")).toBeNull();
    });

    it("derives stable opaque command identities without exposing the session row id", async () => {
        const createCommandId = await createAccountSessionCommandIdFactory(
            TEST_COMMAND_SECRET,
        );

        const commandId = await createCommandId("session_1");
        expect(commandId).toMatch(/^acs_[A-Za-z0-9_-]{43}$/);
        expect(commandId).toBe(await createCommandId("session_1"));
        expect(commandId).not.toContain("session_1");
        expect(await createCommandId("session_2")).not.toBe(commandId);
    });

    it("exposes only bounded presentation data for a session", async () => {
        const createCommandId = await createAccountSessionCommandIdFactory(
            TEST_COMMAND_SECRET,
        );
        const result = presentAccountSession(
            {
                id: "session_1",
                ipAddress: "203.0.113.42",
                userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0.0.0 Safari/537.36",
                impersonatedBy: "admin_2",
                twoFactorVerified: true,
                createdAt: new Date("2026-07-01T10:00:00.000Z"),
                updatedAt: new Date("2026-07-13T10:00:00.000Z"),
                expiresAt: new Date("2026-07-20T10:00:00.000Z"),
            },
            "session_1",
            await createCommandId("session_1"),
        );

        expect(result).toMatchObject({
            commandId: expect.stringMatching(/^acs_[A-Za-z0-9_-]{43}$/),
            current: true,
            networkHint: "203.0.113.x",
            twoFactorVerified: true,
            impersonated: true,
        });
        expect(result).not.toHaveProperty("userAgent");
        expect(result).not.toHaveProperty("ipAddress");
        expect(result).not.toHaveProperty("impersonatedBy");
        expect(result).not.toHaveProperty("token");
        expect(result).not.toHaveProperty("id");
        expect(JSON.stringify(result)).not.toContain("session_1");
    });
});
