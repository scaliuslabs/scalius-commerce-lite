import { describe, expect, it } from "vitest";

import { getAdminUserStatus, isAdminUserAuthorityReady } from "./admin-user-status";

describe("administrator readiness status", () => {
  it("prioritizes unfinished password setup", () => {
    expect(
      getAdminUserStatus({
        twoFactorEnabled: false,
        mustChangePassword: true,
        mustEnrollTwoFactor: true,
        suspended: false,
      }),
    ).toBe("password_setup");
  });

  it("distinguishes pending, expired, and failed administrator invitations", () => {
    const base = {
      twoFactorEnabled: false,
      mustChangePassword: true,
      mustEnrollTwoFactor: true,
      suspended: false,
    };

    expect(getAdminUserStatus({
      ...base,
      invitation: { status: "pending" },
    })).toBe("invite_pending");
    expect(getAdminUserStatus({
      ...base,
      invitation: { status: "expired" },
    })).toBe("invite_expired");
    expect(getAdminUserStatus({
      ...base,
      invitation: { status: "delivery_failed" },
    })).toBe("invite_delivery_failed");
  });

  it("does not call an administrator ready without two-factor authentication", () => {
    expect(
      getAdminUserStatus({
        twoFactorEnabled: false,
        mustChangePassword: false,
        mustEnrollTwoFactor: false,
        suspended: false,
      }),
    ).toBe("two_factor_setup");
  });

  it("reports ready only after both onboarding gates pass", () => {
    expect(
      getAdminUserStatus({
        twoFactorEnabled: true,
        mustChangePassword: false,
        mustEnrollTwoFactor: false,
        suspended: false,
      }),
    ).toBe("ready");
  });

  it("keeps suspension visible ahead of onboarding readiness", () => {
    expect(
      getAdminUserStatus({
        twoFactorEnabled: false,
        mustChangePassword: true,
        mustEnrollTwoFactor: true,
        suspended: true,
      }),
    ).toBe("suspended");
  });

  it("keeps administrator mutations fail-closed while authority is stale", () => {
    expect(isAdminUserAuthorityReady({ isLoading: true, error: null })).toBe(false);
    expect(isAdminUserAuthorityReady({ isLoading: false, error: "offline" })).toBe(false);
    expect(isAdminUserAuthorityReady({ isLoading: false, error: null })).toBe(true);
  });
});
