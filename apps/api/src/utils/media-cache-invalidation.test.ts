import type { Database } from "@scalius/database/client";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidateCatalogCaches: vi.fn(),
}));

vi.mock("./cache-invalidation", async () => {
  const actual = await vi.importActual<typeof import("./cache-invalidation")>(
    "./cache-invalidation",
  );
  return {
    ...actual,
    invalidateCatalogCaches: mocks.invalidateCatalogCaches,
  };
});

import { invalidateMediaDependentProductCaches } from "./media-cache-invalidation";

describe("media dependent product cache invalidation", () => {
  it("purges the complete semantic product projection without dependency scans", async () => {
    const db = {} as Database;
    const context = { env: {} as Env };

    await invalidateMediaDependentProductCaches(db, "media_shared", context);

    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledOnce();
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "products",
      context,
    );
  });
});
