import { describe, expect, it } from "vitest";
import {
  clearThemePreviewCookieHeaders,
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

  it("gives the theme editor's frame a partitioned cookie only the dashboard's site can carry", () => {
    const header = createThemePreviewCookieHeader(TOKEN, { embedded: true });
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=None");
    expect(header).toContain("Partitioned");
    expect(header).not.toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
  });

  it("rejects malformed values and clears the same cookie scope", () => {
    expect(createThemePreviewCookieHeader("not-a-preview")).toBe("");
    expect(readThemePreviewCookie(`${THEME_PREVIEW_COOKIE_NAME}=bad`)).toBe("");
    expect(readThemePreviewCookie(`${THEME_PREVIEW_COOKIE_NAME}=%E0%A4%A`)).toBe("");
    const [lax, framed] = clearThemePreviewCookieHeaders();
    expect(lax).toContain("SameSite=Lax");
    // The editor frame's partitioned cookie is a different cookie: exit must expire it too.
    expect(framed).toContain("SameSite=None");
    expect(framed).toContain("Partitioned");
    for (const header of [lax, framed]) {
      expect(header).toContain(`${THEME_PREVIEW_COOKIE_NAME}=;`);
      expect(header).toContain("Max-Age=0");
      expect(header).toContain("Path=/");
    }
  });
});
