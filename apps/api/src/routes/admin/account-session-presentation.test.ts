import { describe, expect, it } from "vitest";

import {
    createAccountSessionCommandIdFactory,
    describeAccountSessionDevice,
    isLocalNetworkAddress,
    maskAccountSessionIp,
    presentAccountSession,
} from "./account-session-presentation";

const TEST_COMMAND_SECRET = "test-account-session-command-secret";

describe("account session presentation", () => {
    it("derives a useful device label without returning the raw user agent", () => {
        const rawUserAgent =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36";

        expect(describeAccountSessionDevice(rawUserAgent)).toEqual({
            label: "Chrome · macOS",
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
        ).toEqual({ label: "Safari · iPhone", type: "mobile" });
        expect(
            describeAccountSessionDevice(
                "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
            ),
        ).toEqual({ label: "Chrome · Android tablet", type: "tablet" });
    });

    it("masks recognized network addresses and drops malformed values", () => {
        expect(maskAccountSessionIp("203.0.113.42")).toBe("203.0.113.x");
        expect(maskAccountSessionIp("2001:db8:abcd:0012::1")).toBe(
            "2001:db8:abcd:…",
        );
        expect(maskAccountSessionIp("not-an-ip-address")).toBeNull();
    });

    it("calls loopback, private and unspecified addresses the local network", () => {
        for (const local of [
            "0000:0000:0000:0000:0000:0000:0000:0000",
            "::1",
            "::",
            "127.0.0.1",
            "10.2.3.4",
            "172.20.1.1",
            "192.168.0.12",
            "fe80::1",
            "fd12:3456::1",
            "::ffff:192.168.1.5",
        ]) {
            expect(isLocalNetworkAddress(local), local).toBe(true);
        }
        for (const remote of ["203.0.113.42", "172.32.0.1", "2001:db8:abcd:12::1", "not-an-ip", null]) {
            expect(isLocalNetworkAddress(remote), String(remote)).toBe(false);
        }
    });

    it("names the phone browsers Bangladeshi staff use", () => {
        expect(describeAccountSessionDevice(
            "Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
        )).toEqual({ label: "Samsung Internet · Android", type: "mobile" });
        expect(describeAccountSessionDevice(
            "Mozilla/5.0 (Linux; U; Android 10; en-US; RMX2185) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.4.0.1306 Mobile Safari/537.36",
        )).toEqual({ label: "UC Browser · Android", type: "mobile" });
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
            localNetwork: false,
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
