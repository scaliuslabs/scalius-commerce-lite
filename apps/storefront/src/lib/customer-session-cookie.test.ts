import { describe, expect, it } from "vitest";

import { getCustomerSessionTokenFromCookie } from "./customer-session-cookie";

describe("customer session cookie", () => {
  it("extracts the HttpOnly customer session token from a cookie header", () => {
    expect(
      getCustomerSessionTokenFromCookie("theme=dark; cs_tok=session%20123; cs_auth=1"),
    ).toBe("session 123");
  });

  it("returns null when the customer session cookie is absent", () => {
    expect(getCustomerSessionTokenFromCookie("cs_auth=1")).toBeNull();
    expect(getCustomerSessionTokenFromCookie(null)).toBeNull();
  });
});
