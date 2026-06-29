import { describe, expect, it } from "vitest";

import { isNotificationProviderBreakerFailure } from "./notification-provider-health";

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
});
