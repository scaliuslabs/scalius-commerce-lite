import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: () => true,
}));

import { POST } from "./logout";

describe("logout proxy Origin guard", () => {
  it("rejects cross-origin cookie logout requests before clearing cookies", async () => {
    const response = await POST({
      request: new Request("https://storefront.example.test/api/auth/logout", {
        method: "POST",
        headers: {
          Cookie: "cs_tok=session",
          Origin: "https://evil.example.test",
        },
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});
