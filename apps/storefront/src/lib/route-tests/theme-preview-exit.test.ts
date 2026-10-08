import { describe, expect, it } from "vitest";

import { ALL, POST } from "../../pages/theme-preview/exit";

describe("theme preview exit", () => {
  it("expires the tab cookie and the editor frame's partitioned cookie, then returns to the live storefront", async () => {
    const response = await (POST as unknown as () => Promise<Response>)();
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.every((cookie) => cookie.startsWith("stp_theme_preview=;") && cookie.includes("Max-Age=0") && cookie.includes("Path=/"))).toBe(true);
    expect(cookies.some((cookie) => cookie.includes("SameSite=Lax"))).toBe(true);
    expect(cookies.some((cookie) => cookie.includes("SameSite=None") && cookie.includes("Partitioned"))).toBe(true);
  });

  it("refuses other methods", async () => {
    const response = await (ALL as unknown as () => Promise<Response>)();
    expect(response.status).toBe(405);
  });
});
