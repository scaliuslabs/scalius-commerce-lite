import { describe, expect, it } from "vitest";
import {
  clearThemePreviewCookieHeader,
  createThemePreviewCookieHeader,
  readThemePreviewCookie,
  THEME_PREVIEW_COOKIE_NAME,
} from "./theme-preview-cookie";

const TOKEN = `tpv_${"a".repeat(48)}`;

describe("storefront theme preview cookie", () => {
  it("keeps the bearer out of URLs and in a secure HttpOnly host cookie", () => {
    const header = createThemePreviewCookieHeader(TOKEN);
    expect(header).toContain(`${THEME_PREVIEW_COOKIE_NAME}=${TOKEN}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
    expect(readThemePreviewCookie(`other=1; ${THEME_PREVIEW_COOKIE_NAME}=${TOKEN}`)).toBe(TOKEN);
  });

  it("rejects malformed values and clears the same cookie scope", () => {
    expect(createThemePreviewCookieHeader("not-a-preview")).toBe("");
    expect(readThemePreviewCookie(`${THEME_PREVIEW_COOKIE_NAME}=bad`)).toBe("");
    expect(readThemePreviewCookie(`${THEME_PREVIEW_COOKIE_NAME}=%E0%A4%A`)).toBe("");
    expect(clearThemePreviewCookieHeader()).toContain("Max-Age=0");
  });
});
