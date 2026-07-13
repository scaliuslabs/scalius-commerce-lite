import { describe, expect, it } from "vitest";

import { getAdminUserStatus, isAdminUserAuthorityReady } from "./admin-user-status";

describe("administrator readiness status", () => {
  it("prioritizes unfinished password setup", () => {
    expect(
      getAdminUserStatus({
        twoFactorEnabled: false,
        mustChangePassword: true,
        mustEnrollTwoFactor: true,
      }),
    ).toBe("password_setup");
  });

  it("does not call an administrator ready without two-factor authentication", () => {
    expect(
      getAdminUserStatus({
        twoFactorEnabled: false,
        mustChangePassword: false,
        mustEnrollTwoFactor: false,
      }),
    ).toBe("two_factor_setup");
  });

  it("reports ready only after both onboarding gates pass", () => {
    expect(
      getAdminUserStatus({
        twoFactorEnabled: true,
        mustChangePassword: false,
        mustEnrollTwoFactor: false,
      }),
    ).toBe("ready");
  });

  it("keeps administrator mutations fail-closed while authority is stale", () => {
    expect(isAdminUserAuthorityReady({ isLoading: true, error: null })).toBe(false);
    expect(isAdminUserAuthorityReady({ isLoading: false, error: "offline" })).toBe(false);
    expect(isAdminUserAuthorityReady({ isLoading: false, error: null })).toBe(true);
  });
});
