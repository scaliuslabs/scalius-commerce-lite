import { describe, expect, it, vi } from "vitest";

import { createAdminApiFunction } from "./admin-api-function";

describe("createAdminApiFunction", () => {
  it("keeps the existing data-call shape while validating before the handler", async () => {
    const validator = vi.fn((data: { id: string }) => ({ id: data.id.trim() }));
    const handler = vi.fn(async ({ data }: { data: { id: string } }) => data.id);
    const fn = createAdminApiFunction({ method: "GET" })
      .validator(validator)
      .handler(handler);

    await expect(fn({ data: { id: " product_1 " } })).resolves.toBe("product_1");
    expect(validator).toHaveBeenCalledBefore(handler);
  });

  it("supports no-input read functions", async () => {
    const fn = createAdminApiFunction({ method: "GET" })
      .handler(async () => ({ ready: true }));

    await expect(fn()).resolves.toEqual({ ready: true });
  });
});
