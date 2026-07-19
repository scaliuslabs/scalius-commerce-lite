import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveThemePreviewMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ resolveThemePreview: resolveThemePreviewMock }));

import { ALL, POST } from "../../pages/theme-preview/session";

const TOKEN = `tpv_${"a".repeat(48)}`;

function request(body: unknown, origin = "https://storefront.example.test") {
  return new Request("https://storefront.example.test/theme-preview/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify(body),
  });
}

describe("theme preview session route", () => {
  beforeEach(() => resolveThemePreviewMock.mockReset());

  it("sets a secure HttpOnly cookie only after same-origin token resolution", async () => {
    resolveThemePreviewMock.mockResolvedValueOnce({ draftRevision: 3 });
    const response = await POST({ request: request({ token: TOKEN }) } as never);

    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain(`stp_theme_preview=${TOKEN}`);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(await response.text()).toBe("");
    expect(resolveThemePreviewMock).toHaveBeenCalledWith(TOKEN);
  });

  it("rejects a cross-origin request before resolving the bearer", async () => {
    const response = await POST({
      request: request({ token: TOKEN }, "https://dashboard.example.test"),
    } as never);

    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(resolveThemePreviewMock).not.toHaveBeenCalled();
  });

  it("rejects malformed and expired sessions without setting a cookie", async () => {
    const malformed = await POST({ request: request({ token: "bad" }) } as never);
    expect(malformed.status).toBe(400);
    expect(resolveThemePreviewMock).not.toHaveBeenCalled();

    resolveThemePreviewMock.mockResolvedValueOnce(null);
    const expired = await POST({ request: request({ token: TOKEN }) } as never);
    expect(expired.status).toBe(404);
    expect(expired.headers.get("Set-Cookie")).toBeNull();
  });

  it("allows POST only", async () => {
    const response = await ALL({} as never);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});
