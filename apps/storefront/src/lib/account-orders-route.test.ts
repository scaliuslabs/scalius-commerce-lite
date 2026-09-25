// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ACCOUNT_ORDERS_HREF, GET } from "@/pages/account/orders/index";

describe("/account/orders", () => {
  it("sends buyers to the order history on /account instead of a 404", async () => {
    const response = await GET({} as Parameters<typeof GET>[0]);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(ACCOUNT_ORDERS_HREF);
    expect(ACCOUNT_ORDERS_HREF).toBe("/account");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
